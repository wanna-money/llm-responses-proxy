import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, '..', 'config.json');

// Returns raw config from disk without env var injection — use this when you need
// the stored keys exactly as written (e.g. key-merge logic in PUT /api/config).
export function loadRawConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to load config from ${CONFIG_PATH}: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('config.json must be a JSON object');
  if (!Array.isArray(raw.providers)) raw.providers = [];
  return raw;
}

export function loadConfig() {
  const raw = loadRawConfig();
  raw.providers = raw.providers.map(p => {
    if (typeof p.name !== 'string') return p;
    const envSegment = p.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const envKey = process.env[`PROVIDER_${envSegment}_API_KEY`];
    const envBaseUrl = process.env[`PROVIDER_${envSegment}_BASE_URL`];
    return { ...p, ...(envKey ? { apiKey: envKey } : {}), ...(envBaseUrl ? { baseUrl: envBaseUrl } : {}) };
  });
  // #16: validate PORT env var — reject non-numeric strings like "123abc"
  if (process.env.PORT) {
    const portStr = process.env.PORT.trim();
    const p = parseInt(portStr, 10);
    if (Number.isInteger(p) && p >= 1 && p <= 65535 && String(p) === portStr) {
      raw.port = p;
    } else {
      process.stderr.write(`[config] PORT env var "${process.env.PORT}" is not a valid port — ignored\n`);
    }
  }
  if (process.env.UI_PORT) {
    const portStr = process.env.UI_PORT.trim();
    const p = parseInt(portStr, 10);
    if (Number.isInteger(p) && p >= 1 && p <= 65535 && String(p) === portStr) {
      raw.uiPort = p;
    } else {
      process.stderr.write(`[config] UI_PORT env var "${process.env.UI_PORT}" is not a valid port — ignored\n`);
    }
  }
  return raw;
}

export function saveConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Invalid config');
  if (!Array.isArray(config.providers)) throw new Error('providers must be an array');
  // #2: require at least one provider
  if (config.providers.length === 0) throw new Error('providers must not be empty');
  if (config.port !== undefined) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Invalid port');
  }
  if (config.uiPort !== undefined) {
    const p = Number(config.uiPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Invalid uiPort');
  }
  // #8: proxy port and UI port must not be the same
  if (config.port !== undefined && config.uiPort !== undefined && Number(config.port) === Number(config.uiPort)) {
    throw new Error('port and uiPort must be different');
  }
  const names = new Set();
  const envSegments = new Set();
  for (const p of config.providers) {
    // #3: reject blank/whitespace-only names
    if (!p.name || typeof p.name !== 'string' || !p.name.trim()) throw new Error('Each provider must have a non-empty name');
    // #5: use trimmed name for duplicate detection so " openai" and "openai" are caught
    if (names.has(p.name.trim())) throw new Error(`Duplicate provider name: ${p.name}`);
    names.add(p.name.trim());
    // #9: also reject names that collapse to the same env var segment (e.g. "openai" vs "OPENAI")
    const seg = p.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (envSegments.has(seg)) throw new Error(`Provider name "${p.name}" conflicts with another provider (same env var key: PROVIDER_${seg}_API_KEY)`);
    envSegments.add(seg);
    // #3: require a valid baseUrl
    if (!p.baseUrl || typeof p.baseUrl !== 'string' || !p.baseUrl.trim()) throw new Error(`Provider "${p.name}" must have a baseUrl`);
    // #6: validate baseUrl protocol — only http and https are allowed; trim before parse so leading/trailing spaces don't cause false Invalid URL errors
    let parsedUrl;
    try { parsedUrl = new URL(p.baseUrl.trim()); } catch { throw new Error(`Invalid baseUrl for provider "${p.name}": ${p.baseUrl}`); }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Provider "${p.name}" baseUrl must use http or https`);
    }
    // validate optional apiKeyHeader — must be a non-empty string with no newlines (HTTP header injection guard)
    if (p.apiKeyHeader !== undefined) {
      if (typeof p.apiKeyHeader !== 'string' || !p.apiKeyHeader.trim() || /[\r\n]/.test(p.apiKeyHeader)) {
        throw new Error(`Provider "${p.name}" apiKeyHeader must be a non-empty string without newlines`);
      }
    }
  }
  const trimmedActive = config.activeProvider ? config.activeProvider.trim() : config.activeProvider;
  if (trimmedActive && !config.providers.find(p => p.name.trim() === trimmedActive)) {
    throw new Error(`activeProvider "${trimmedActive}" not found in providers`);
  }
  // #1/#10: strip masked API keys before persisting — detect masking by prefix of asterisks,
  // not mere presence of '*', to avoid incorrectly stripping keys that legitimately contain '*'.
  // #6: trim name and baseUrl so activeProvider lookup and env var mapping work correctly
  const safe = {
    ...config,
    ...(config.activeProvider !== undefined ? { activeProvider: trimmedActive } : {}),
    providers: config.providers.map(({ _originalName, ...p }) => ({
      ...p,
      name: p.name.trim(),
      baseUrl: p.baseUrl.trim(),
      apiKey: isMaskedKey(p.apiKey) ? undefined : p.apiKey
    }))
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(safe, null, 2), 'utf8');
}

// A masked key from maskApiKey() always has the form: N asterisks + exactly 4 non-asterisk chars,
// where N = key.length - 4. We require at least 2 asterisks so very short keys (≤5 chars total)
// that start with a single '*' are not misidentified as masked.
// All-asterisk strings (e.g. "****") are also treated as masked.
function isMaskedKey(key) {
  if (!key) return false;
  return /^\*{2,}[^*]{4}$/.test(key) || /^\*+$/.test(key);
}

export function getActiveProvider() {
  const cfg = loadConfig();
  const active = cfg.activeProvider ? cfg.activeProvider.trim() : cfg.activeProvider;
  const provider = cfg.providers.find(p => p.name === active) || cfg.providers[0];
  if (!provider) throw new Error('No providers configured');
  return provider;
}

export function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 4) return '*'.repeat(key.length);
  return '*'.repeat(key.length - 4) + key.slice(-4);
}

export function getMaskedConfig() {
  const cfg = loadConfig();
  return {
    ...cfg,
    providers: cfg.providers.map(p => ({ ...p, apiKey: maskApiKey(p.apiKey) }))
  };
}
