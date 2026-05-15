import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = process.env.LOG_PATH || join(__dirname, '..', 'logs', 'proxy.log');
const MAX_ENTRIES = 1000;

const memLog = [];
// #9: monotonic counter — used as stable unique id so same-millisecond writes don't collide
let logSeq = 0;

function ensureLogDir() {
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Always re-reads from disk so the UI process sees entries written by the proxy process.
// Each OS process has its own in-memory memLog; we keep it in sync by syncing from disk
// before every read and after every write.
function loadFromDisk() {
  memLog.length = 0;
  logSeq = 0;
  try {
    const raw = readFileSync(LOG_PATH, 'utf8').trim();
    if (!raw) return;
    for (const line of raw.split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry._seq == null) entry._seq = ++logSeq;
        else if (entry._seq >= logSeq) logSeq = entry._seq;
        memLog.push(entry);
      } catch {}
    }
  } catch {}
}

function flushToDisk() {
  ensureLogDir();
  // Write to a temp file then rename — atomic on POSIX, prevents partial reads by concurrent processes
  const tmp = `${LOG_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, memLog.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  renameSync(tmp, LOG_PATH);
}

export function maskAuth(value) {
  if (!value) return value;
  const m = value.match(/^(Bearer\s+)(.+)$/i);
  if (m) {
    const token = m[2];
    const visible = token.length > 4 ? token.slice(-4) : token;
    return m[1] + '*'.repeat(Math.max(0, token.length - 4)) + visible;
  }
  return value.length > 4 ? '*'.repeat(value.length - 4) + value.slice(-4) : '*'.repeat(value.length);
}

const SENSITIVE_KEYS = new Set([
  'api_key', 'apiKey',
  'authorization', 'Authorization',
  'x-api-key', 'X-API-Key', 'X-Api-Key',
  'access_token', 'refresh_token', 'token',
  'secret', 'client_secret',
]);

// #13: recursively sanitize sensitive fields at any nesting depth
function sanitizeBody(body, depth = 0) {
  if (body == null || depth > 10) return body;
  if (typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map(item => sanitizeBody(item, depth + 1));
  const clone = {};
  for (const [k, v] of Object.entries(body)) {
    clone[k] = SENSITIVE_KEYS.has(k) ? maskAuth(String(v)) : sanitizeBody(v, depth + 1);
  }
  return clone;
}

export function buildLogEntry({ url, reqBody, resStatus, resBody, stream = false }) {
  return {
    url,
    reqBody: sanitizeBody(reqBody),
    resStatus,
    ...(stream ? { stream: true } : { resBody: sanitizeBody(resBody) })
  };
}

export function appendLog(entry) {
  ensureLogDir();
  const ts = new Date().toISOString();
  // Generate a seq that is unique across processes: load only the current max seq from disk,
  // increment, then append a single line. This is much cheaper than a full load+rewrite and
  // the append syscall itself is atomic on POSIX (O_APPEND), so two concurrent appends cannot
  // interleave partial lines.
  let maxSeq = logSeq;
  try {
    const raw = readFileSync(LOG_PATH, 'utf8').trim();
    if (raw) {
      for (const line of raw.split('\n')) {
        try { const e = JSON.parse(line); if (e._seq > maxSeq) maxSeq = e._seq; } catch {}
      }
    }
  } catch {}
  logSeq = maxSeq + 1;
  const seq = logSeq;
  const record = { ...entry, ts, _seq: seq };
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  return seq;
}

export function patchLog(seq, patch) {
  loadFromDisk();
  const idx = memLog.findIndex(e => e._seq === seq);
  if (idx !== -1) {
    memLog[idx] = { ...memLog[idx], ...patch };
    flushToDisk();
  }
}

export function clearLogs() {
  loadFromDisk();
  memLog.length = 0;
  flushToDisk();
}

export function getLogs({ limit = 100, offset = 0 } = {}) {
  loadFromDisk();
  // Trim to MAX_ENTRIES in memory; if file has grown beyond that, rewrite it compacted.
  if (memLog.length > MAX_ENTRIES) {
    memLog.splice(0, memLog.length - MAX_ENTRIES);
    flushToDisk();
  }
  const reversed = memLog.slice().reverse();
  return {
    total: memLog.length,
    entries: reversed.slice(offset, offset + limit)
  };
}
