import { strict as assert } from 'assert';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpConfig = join(__dirname, 'tmp-config.json');

const sampleConfig = {
  port: 18188,
  activeProvider: 'testprovider',
  providers: [{ name: 'testprovider', baseUrl: 'https://example.com', apiKey: 'file-key' }]
};
writeFileSync(tmpConfig, JSON.stringify(sampleConfig, null, 2));
process.env.CONFIG_PATH = tmpConfig;

const { loadConfig, loadRawConfig, saveConfig, getActiveProvider, maskApiKey } = await import('../src/config.js');

test('loadConfig returns parsed config', () => {
  const cfg = loadConfig();
  assert.equal(cfg.activeProvider, 'testprovider');
  assert.equal(cfg.providers.length, 1);
});

test('env var overrides apiKey', () => {
  process.env.PROVIDER_TESTPROVIDER_API_KEY = 'env-key';
  const cfg = loadConfig();
  assert.equal(cfg.providers[0].apiKey, 'env-key');
  delete process.env.PROVIDER_TESTPROVIDER_API_KEY;
});

test('getActiveProvider returns correct provider', () => {
  const provider = getActiveProvider();
  assert.equal(provider.name, 'testprovider');
  assert.equal(provider.baseUrl, 'https://example.com');
});

test('maskApiKey masks all but last 4 chars', () => {
  assert.equal(maskApiKey('sk-abcdefgh'), '*******efgh');
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('abcd'), '****');
});

test('saveConfig writes to file', () => {
  const newConfig = { ...sampleConfig, port: 19000 };
  saveConfig(newConfig);
  const written = JSON.parse(readFileSync(tmpConfig, 'utf8'));
  assert.equal(written.port, 19000);
  saveConfig(sampleConfig);
});

test('PORT env var rejects non-numeric strings like "123abc"', () => {
  process.env.PORT = '123abc';
  const cfg = loadConfig();
  assert.notEqual(cfg.port, 123);
  delete process.env.PORT;
});

test('PORT env var accepts valid integer strings', () => {
  process.env.PORT = '19999';
  const cfg = loadConfig();
  assert.equal(cfg.port, 19999);
  delete process.env.PORT;
});

test('loadRawConfig does not inject env var apiKey', () => {
  process.env.PROVIDER_TESTPROVIDER_API_KEY = 'env-key';
  const raw = loadRawConfig();
  assert.equal(raw.providers[0].apiKey, 'file-key');
  delete process.env.PROVIDER_TESTPROVIDER_API_KEY;
});

test('saveConfig strips masked apiKey before writing', () => {
  const config = {
    ...sampleConfig,
    // maskApiKey('sk-1234abcd') → '******abcd' (6 asterisks + last 4 chars)
    providers: [{ name: 'testprovider', baseUrl: 'https://example.com', apiKey: '******abcd' }]
  };
  saveConfig(config);
  const written = JSON.parse(readFileSync(tmpConfig, 'utf8'));
  assert.equal(written.providers[0].apiKey, undefined, 'masked key must not be persisted');
  saveConfig(sampleConfig);
});

test('saveConfig preserves real apiKey containing asterisk in middle', () => {
  const config = {
    ...sampleConfig,
    providers: [{ name: 'testprovider', baseUrl: 'https://example.com', apiKey: 'sk-abc*def' }]
  };
  saveConfig(config);
  const written = JSON.parse(readFileSync(tmpConfig, 'utf8'));
  assert.equal(written.providers[0].apiKey, 'sk-abc*def');
  saveConfig(sampleConfig);
});

test('saveConfig rejects invalid uiPort', () => {
  const config = { ...sampleConfig, uiPort: 99999 };
  assert.throws(() => saveConfig(config), /Invalid uiPort/);
});

test('saveConfig rejects port/uiPort conflict', () => {
  const config = { ...sampleConfig, port: 18188, uiPort: 18188 };
  assert.throws(() => saveConfig(config), /port and uiPort must be different/);
});

test('saveConfig rejects case-colliding provider names', () => {
  const config = {
    port: 18188,
    activeProvider: 'openai',
    providers: [
      { name: 'openai', baseUrl: 'https://api.openai.com', apiKey: '' },
      { name: 'OPENAI', baseUrl: 'https://api.openai.com', apiKey: '' }
    ]
  };
  assert.throws(() => saveConfig(config), /conflicts with another provider/);
});

test('saveConfig rejects providers with same env var segment via special chars', () => {
  const config = {
    port: 18188,
    activeProvider: 'my-provider',
    providers: [
      { name: 'my-provider', baseUrl: 'https://example.com', apiKey: '' },
      { name: 'my_provider', baseUrl: 'https://example.com', apiKey: '' }
    ]
  };
  assert.throws(() => saveConfig(config), /conflicts with another provider/);
});
