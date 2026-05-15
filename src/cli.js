#!/usr/bin/env node
import { execFileSync, spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DEFAULT_CONFIG = {
  port: 18188,
  uiPort: 18189,
  activeProvider: 'default',
  providers: [
    { name: 'default', baseUrl: 'https://api.openai.com', apiKey: '' }
  ]
};

function ensureConfig() {
  const cfgPath = process.env.CONFIG_PATH || join(process.cwd(), 'config.json');
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    console.log(`Created default config at ${cfgPath}`);
    console.log('Edit it to set your provider baseUrl and apiKey before starting.');
  }
  return cfgPath;
}

const [,, cmd] = process.argv;

if (cmd === 'start') {
  const cfgPath = ensureConfig();
  const child = spawn('node', [join(__dirname, 'ui-server.js')], {
    stdio: 'inherit',
    env: { ...process.env, CONFIG_PATH: process.env.CONFIG_PATH || cfgPath }
  });
  child.on('exit', code => process.exit(code ?? 0));

} else if (cmd === 'ui') {
  const { loadConfig } = await import('./config.js');
  const cfg = loadConfig();
  const uiPort = cfg.uiPort || 18189;
  const url = `http://localhost:${uiPort}/ui`;
  console.log(`Opening UI: ${url}`);
  try {
    if (process.platform === 'win32') {
      // 'start' is a shell built-in on Windows — must invoke via cmd /c
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFileSync(opener, [url], { stdio: 'ignore' });
    }
  } catch {
    console.log(`Could not open browser automatically. Visit: ${url}`);
  }

} else {
  console.log(`Usage:
  llm-responses-proxy start   Start the proxy server
  llm-responses-proxy ui      Open the config UI in browser`);
  process.exit(1);
}
