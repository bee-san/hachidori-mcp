// SPDX-License-Identifier: GPL-3.0-or-later
// Real MCP stdio → Python Anki relay → Chromium extension → production WASM.
// Requires sibling checkouts or HACHIDORI_PATH / HACHIDORI_ANKI_PATH, Hachidori's
// test/tooling dependencies, a Chromium executable and python3. Uses fixtures;
// never downloads a production dictionary or touches the user's browser profile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../', import.meta.url));
const extensionRepo = resolve(process.env.HACHIDORI_PATH || join(root, '../hachidori'));
const ankiRepo = resolve(process.env.HACHIDORI_ANKI_PATH || join(root, '../hachidori-anki'));
const moduleAt = path => import(pathToFileURL(join(extensionRepo, path)));

async function until(read, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function chromeExecutable() {
  if (process.env.HACHIDORI_CHROME) return process.env.HACHIDORI_CHROME;
  const cache = join(extensionRepo, 'test/tmp/browsers/chrome');
  if (existsSync(cache)) for (const entry of readdirSync(cache).sort().reverse()) {
    const path = join(cache, entry, 'chrome-linux64/chrome');
    if (existsSync(path)) return path;
  }
  return '/usr/bin/google-chrome';
}

test('French profile, dictionary, settings, script installation and lookup through the real relay', { timeout: 240_000 }, async t => {
  const { startAnkiRelayServer } = await moduleAt('test/anki-relay-server.mjs');
  const { buildLanguageFixtureZip } = await moduleAt('test/make-language-fixtures.mjs');
  const { buildFixtureZip } = await moduleAt('test/make-fixture.mjs');
  const { default: puppeteer } = await moduleAt('test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');
  const directory = await mkdtemp(join(tmpdir(), 'hachidori-mcp-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const relay = await startAnkiRelayServer({ serverPath: join(ankiRepo, 'addon/server.py') });
  t.after(() => relay.close());
  const browser = await puppeteer.launch({ executablePath: chromeExecutable(), enableExtensions: true, headless: true,
    userDataDir: join(directory, 'profile'), args: ['--no-sandbox', '--disable-dev-shm-usage',
      `--disable-extensions-except=${join(extensionRepo, 'extension')}`, `--load-extension=${join(extensionRepo, 'extension')}`] });
  t.after(() => browser.close());
  const worker = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'));
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/settings.html#dictionaries`);
  const message = request => page.evaluate(request => chrome.runtime.sendMessage({ requestId: 'mcp-e2e', ...request }), request);
  await until(async () => (await message({ target: 'hoshidicts-offscreen', type: 'hd_status' }))?.ready, 'engine startup');
  const japanese = join(directory, 'ja.zip');
  await writeFile(japanese, buildFixtureZip());
  await page.waitForSelector('#import-file');
  await (await page.$('#import-file')).uploadFile(japanese);
  await until(async () => (await page.evaluate(() => chrome.storage.local.get('dictionaryState'))).dictionaryState?.dictionaries?.length > 0, 'initial dictionary');
  const sharing = await message({ target: 'hachidori-sharing', type: 'hd_sharing_host_enable', port: relay.port });
  assert.equal(sharing.ok, true, sharing.error);
  await until(async () => (await message({ target: 'hachidori-sharing', type: 'hd_sharing_status' })).sharing.connected, 'sharing host');
  const client = new Client({ name: 'integration', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/cli.js')],
    env: { ...process.env, HACHIDORI_RELAY_URL: `ws://127.0.0.1:${relay.port}/link` }, stderr: 'inherit' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const setup = await call('hachidori_setup_language', { language: 'French', dictionaryUrls: [] });
  assert.equal(setup.activeProfileId, 'fr');
  assert.equal(setup.readyForLookups, false);
  const french = join(directory, 'fr.zip');
  await writeFile(french, buildLanguageFixtureZip({ title: 'mcp-french-fixture', sourceLanguage: 'fr', targetLanguage: 'en',
    terms: [['bonjour', '', '', '', 0, ['hello'], 1, '']] }));
  await call('hachidori_import_dictionary', { path: french, profileId: 'fr' });
  const ready = await call('hachidori_setup_language', { language: 'fr' });
  assert.equal(ready.readyForLookups, true, 'a repeat setup reuses the installed dictionary without a network download');
  const before = await call('hachidori_get_settings', { profileId: 'fr', keys: ['scanLength'] });
  await call('hachidori_update_settings', { profileId: 'fr', baseRevision: before.revision, options: { scanLength: 24 } });
  const changed = await call('hachidori_get_settings', { profileId: 'fr', keys: ['scanLength'] });
  assert.equal(changed.options.scanLength, 24);
  const conflict = await client.callTool({ name: 'hachidori_update_settings', arguments: { profileId: 'fr', baseRevision: before.revision, options: { scanLength: 20 } } });
  assert.equal(conflict.isError, true);
  const saved = await call('hachidori_save_userscript', { name: 'MCP fixture', baseRevision: changed.revision,
    javascript: 'window.addEventListener("hachidori-popup-shown", () => {});', css: ':host { --mcp-fixture: 1; }' });
  const scripts = await call('hachidori_list_userscripts', { includeCode: true });
  assert.ok(scripts.scripts.some(script => script.id === saved.id && script.css.includes('--mcp-fixture')));
  const lookup = await message({ target: 'hoshidicts-offscreen', type: 'hd_lookup', profileId: 'fr', text: 'bonjour', maxResults: 10, scanLength: 24, options: {} });
  assert.equal(lookup.ok, true, lookup.error);
  assert.match(JSON.stringify(lookup), /hello/);
  const stored = await page.evaluate(() => chrome.storage.local.get(['options', 'languageSelection']));
  assert.equal(stored.languageSelection.activeProfileId, 'fr');
  assert.equal(stored.options.profiles.find(profile => profile.id === 'fr').settings.scanLength, 24);
  assert.notEqual(stored.options.profiles.find(profile => profile.id === 'ja').settings.scanLength, 24);
});
