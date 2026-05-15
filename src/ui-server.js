import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import { loadConfig, loadRawConfig, saveConfig, getMaskedConfig } from './config.js';
import { getLogs, clearLogs } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

let proxyProc = null;
let proxyStatus = 'stopped'; // 'starting' | 'running' | 'stopped' | 'error'
let proxyPid = null;
let proxyPort = null;
let lastError = null;
let startedAt = null;
let spawnTimer = null; // #14: track pending spawn timer so stopProxy can cancel it

function startProxy() {
  const cfg = loadConfig();
  proxyPort = cfg.port || 18188;
  proxyStatus = 'starting';
  lastError = null;
  startedAt = null;

  // Kill any orphaned process already on the proxy port, then spawn after a brief delay
  killPortProcess(proxyPort);
  spawnTimer = setTimeout(_spawnProxy, 300);
}

function _spawnProxy() {
  spawnTimer = null; // #8: timer has fired — clear reference so stopProxy can tell no spawn is pending
  proxyProc = spawn('node', [join(__dirname, 'index.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  proxyPid = proxyProc.pid;

  proxyProc.stdout.on('data', data => {
    const line = data.toString().trim();
    process.stdout.write(`[proxy] ${line}\n`);
    if (line.includes('listening')) {
      proxyStatus = 'running';
      startedAt = new Date().toISOString();
    }
  });

  proxyProc.stderr.on('data', data => {
    const line = data.toString().trim();
    process.stderr.write(`[proxy:err] ${line}\n`);
    lastError = line;
    // Don't flip to error on stderr alone — only on process exit with non-zero code
  });

  proxyProc.on('exit', (code, signal) => {
    const normalExit = code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL';
    proxyStatus = normalExit ? 'stopped' : 'error';
    if (!normalExit && code !== null) lastError = `exited with code ${code}`;
    proxyProc = null;
    proxyPid = null;
  });
}

function killPortProcess(port, knownPid = null) {
  // guard: port must be a safe integer to avoid shell injection
  const safePort = Math.floor(Number(port));
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) return;
  try {
    // use execFileSync (not execSync) with array args — avoids shell interpretation entirely
    const out = execFileSync('lsof', ['-ti', `tcp:${safePort}`, '-c', 'node'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (out) {
      const pids = out.split('\n').map(s => s.trim()).filter(Boolean).map(Number).filter(Boolean);
      for (const pid of pids) {
        // When we have a known proxy PID, only kill that exact process.
        if (knownPid !== null && pid !== knownPid) continue;
        // At startup (knownPid=null), verify the process is actually our proxy script
        // before killing — avoids accidentally killing unrelated node processes on the same port.
        if (knownPid === null) {
          try {
            const proxyScript = join(__dirname, 'index.js');
            const cmdline = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            if (!cmdline.includes(proxyScript)) continue;
          } catch { continue; }
        }
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
  } catch {}
}

function stopProxy() {
  return new Promise(resolve => {
    // #14: cancel any pending spawn timer so stop doesn't get undone
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null; }
    proxyStatus = 'stopped';
    if (!proxyProc) {
      // No tracked child — kill any orphaned process on the proxy port (best-effort, no known PID)
      killPortProcess(proxyPort || loadConfig().port || 18188);
      return setTimeout(resolve, 500);
    }
    // Capture the child reference now so the SIGKILL fallback always targets the
    // process we just asked to stop, not whatever proxyProc points to at fire time.
    const child = proxyProc;
    const killTimer = setTimeout(() => { if (child) child.kill('SIGKILL'); }, 3000);
    proxyProc.once('exit', () => { clearTimeout(killTimer); resolve(); });
    proxyProc.kill('SIGTERM');
  });
}

// ── API routes ────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const cfg = loadConfig();
  res.json({
    status: proxyStatus,
    pid: proxyPid,
    proxyPort: proxyPort || cfg.port || 18188,
    startedAt,
    lastError
  });
});

// #18: serialize restarts — ignore concurrent requests while one is in progress
let restartInProgress = false;
app.post('/api/restart', async (req, res) => {
  if (restartInProgress) return res.status(409).json({ error: 'restart already in progress' });
  restartInProgress = true;
  try {
    await stopProxy();
    startProxy();
    res.json({ ok: true });
  } finally {
    restartInProgress = false;
  }
});

app.post('/api/stop', async (req, res) => {
  if (restartInProgress) return res.status(409).json({ error: 'restart already in progress' });
  await stopProxy();
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json(getMaskedConfig());
});

app.put('/api/config', (req, res) => {
  try {
    // #1: merge incoming masked API keys with stored real keys so saving from
    // the UI never overwrites a real key with its masked representation.
    const stored = loadRawConfig();
    const incoming = req.body;
    if (Array.isArray(incoming.providers)) {
      incoming.providers = incoming.providers.map(p => {
        // #4: use _originalName for key-merge so rename doesn't lose the stored key
        const lookupName = p._originalName || p.name;
        const storedProvider = stored.providers.find(s => s.name === lookupName);
        const { _originalName, ...rest } = p;
        // If the incoming key looks masked (starts with *) and we have a real stored key, keep the real one
        if (storedProvider && rest.apiKey && /^\*/.test(rest.apiKey)) {
          return { ...rest, apiKey: storedProvider.apiKey };
        }
        return rest;
      });
    }
    saveConfig(incoming);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  res.json(getLogs({ limit, offset }));
});

app.delete('/api/logs', (req, res) => {
  clearLogs();
  res.json({ ok: true });
});

app.get('/ui', (req, res) => {
  res.sendFile(join(__dirname, 'ui.html'));
});

app.get('/', (req, res) => res.redirect('/ui'));

// ── Start ────────────────────────────────────────────────────

const cfg = loadConfig();
const uiPort = cfg.uiPort || 18189;
// #2: bind to 127.0.0.1 — do not expose on all interfaces
app.listen(uiPort, '127.0.0.1', () => {
  console.log(`[ui]    http://localhost:${uiPort}/ui`);
  startProxy();
});

process.on('SIGTERM', async () => { await stopProxy(); process.exit(0); });
process.on('SIGINT', async () => { await stopProxy(); process.exit(0); });
