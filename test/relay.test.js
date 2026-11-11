// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Relay, CAPABILITY, TARGET, relayAddress } from '../src/relay.js';
import { Hachidori } from '../src/hachidori.js';
import { findDictionary } from '../src/dictionaries.js';

export async function fakeHost(t, handle, { capability = CAPABILITY } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { for (const socket of server.clients) socket.terminate(); server.close(resolve); }));
  const frames = [];
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.origin, 'hoshi://hoshidicts');
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes);
      frames.push(frame);
      const reply = response => socket.send(JSON.stringify({ kind: 'reply', id: frame.id, response }));
      if (frame.kind === 'hello') {
        socket.send(JSON.stringify({ kind: 'hello', protocol: 1, capabilities: [capability], snapshot: { privateHistory: 'never-output' } }));
        socket.send(JSON.stringify({ kind: 'ping' }));
      } else if (frame.message?.type === 'hd_language_profiles_opt_in') reply({ optIn: frame.message.languages.length ? 'accepted' : 'refused', hostLanguages: ['ja', 'fr'], snapshot: {} });
      else if (frame.kind === 'request') handle({ frame, socket, reply });
    });
  });
  return { relay: new Relay({ url: `ws://127.0.0.1:${server.address().port}/link`, timeoutMs: 300 }), frames };
}

test('real WebSocket handshake, language opt-in, ping and response correlation', async t => {
  const { relay, frames } = await fakeHost(t, ({ reply }) => reply({ ok: true, revision: 3 }));
  const response = await relay.call(TARGET, 'hd_mcp_describe');
  assert.deepEqual(response, { ok: true, revision: 3 });
  assert.ok(frames.some(frame => frame.kind === 'pong'));
  assert.deepEqual(frames.filter(frame => frame.message?.type === 'hd_language_profiles_opt_in').map(frame => frame.message.languages), [[], ['ja', 'fr']]);
});

test('old host fails with an actionable compatibility error', async t => {
  const { relay } = await fakeHost(t, () => {}, { capability: 'old' });
  await assert.rejects(relay.call(TARGET, 'hd_mcp_describe'), /Update Hachidori/);
});

test('disconnect after a write reports unknown outcome and never replays', async t => {
  let writes = 0;
  const { relay } = await fakeHost(t, ({ socket }) => { writes++; socket.close(); });
  await assert.rejects(relay.call(TARGET, 'hd_mcp_options_write', {}, { mutating: true }), error => error.details.outcomeUnknown && /unknown/.test(error.message));
  assert.equal(writes, 1);
});

test('request timeout is bounded and a later operation opens a new session', async t => {
  let calls = 0;
  const { relay } = await fakeHost(t, ({ reply }) => { if (++calls > 1) reply({ ok: true }); });
  await assert.rejects(relay.call(TARGET, 'hd_mcp_describe'), /in time/);
  assert.deepEqual(await relay.call(TARGET, 'hd_mcp_describe'), { ok: true });
});

test('cancelled mutations report uncertain outcome; host errors preserve conflict without returning raw options', async t => {
  const controller = new AbortController();
  const { relay } = await fakeHost(t, ({ reply, frame }) => {
    if (frame.message.type === 'cancel') controller.abort();
    else reply({ ok: false, conflict: true, error: 'Settings changed', options: { apiKey: 'private' } });
  });
  await assert.rejects(relay.call(TARGET, 'cancel', {}, { mutating: true, signal: controller.signal }), error => error.details.outcomeUnknown);
  await assert.rejects(relay.call(TARGET, 'hd_mcp_options_write'), error => error.details.conflict && !JSON.stringify(error.details).includes('private'));
});

test('syntax checking supports function return, rejects malformed code and never executes scripts', async () => {
  const sent = [];
  const app = new Hachidori({ call: async (...args) => { sent.push(args); return { options: { revision: 2 } }; } });
  await app.saveScript({ id: 'safe', baseRevision: 1, name: 'Example', javascript: 'globalThis.mcpExecuted = true; return;' });
  assert.equal(globalThis.mcpExecuted, undefined);
  assert.throws(() => app.saveScript({ baseRevision: 2, javascript: 'const =' }), SyntaxError);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][2].script, { name: 'Example', javascript: 'globalThis.mcpExecuted = true; return;' });
});

test('catalogue checks availability before constructing the upstream download URL', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ date: 'fixture', dicts: { main: { sources: { fr: { targets: { en: '10 MB' } } } } } }) });
  const result = await findDictionary('fr', 'en', { fetcher });
  assert.equal(result.url, 'https://huggingface.co/datasets/daxida/wty-release/resolve/main/latest/dict/fr/en/wty-fr-en.zip');
  await assert.rejects(findDictionary('fr', 'xx', { fetcher }), /No Wiktionary/);
  assert.throws(() => relayAddress('https://example.com/link'), /must be/);
  assert.throws(() => relayAddress('ws://user:password@localhost/link'), /must be/);
});

test('French setup reconnects after first profile creation, preserves existing state and reports partial failure', async t => {
  const state = { revision: 2, selection: { revision: 0 }, activeProfileId: 'ja', profiles: [{ id: 'ja', language: 'ja' }],
    languages: [{ code: 'ja', name: 'Japanese' }, { code: 'fr', name: 'French', nativeName: 'Français' }], dictionaries: [] };
  let failSelection = true;
  const { relay, frames } = await fakeHost(t, ({ frame, reply, socket }) => {
    const message = frame.message;
    if (message.type === 'hd_mcp_describe') reply({ ...state, profileId: message.profileId || state.activeProfileId });
    else if (message.type === 'hd_profile_add') {
      state.profiles.push({ id: 'fr', language: 'fr' });
      state.revision++;
      reply({ ok: true });
      socket.close();
    } else if (message.type === 'hd_mcp_options_write') {
      assert.equal(message.baseRevision, state.revision);
      assert.deepEqual(message.options, { experimental: { multipleLanguages: true } });
      state.revision++;
      reply({ options: { revision: state.revision } });
    } else if (message.type === 'hd_mcp_select_profile') {
      if (failSelection) reply({ ok: false, conflict: true, error: 'selection changed' });
      else { state.activeProfileId = message.profileId; state.selection.revision++; reply({ selection: state.selection }); }
    }
  });
  const app = new Hachidori(relay);
  await assert.rejects(app.setupLanguage({ language: 'French', dictionaryUrls: [] }), error => {
    assert.deepEqual(error.details.completed, ['profile-created', 'multiple-languages-enabled']);
    assert.equal(error.details.conflict, true);
    return true;
  });
  failSelection = false;
  const result = await app.setupLanguage({ language: 'fr', dictionaryUrls: [] });
  assert.equal(result.activeProfileId, 'fr');
  assert.equal(result.readyForLookups, false);
  assert.equal(frames.filter(frame => frame.message?.type === 'hd_profile_add').length, 1);
});

test('dictionary chunks share one upload owner and preserve the source file', async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { importDictionary } = await import('../src/dictionaries.js');
  const directory = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.zip');
  const bytes = Buffer.from('a dictionary fixture split across several chunks');
  await writeFile(path, bytes);
  const chunks = [];
  let owner, offset = 0;
  const { relay } = await fakeHost(t, ({ frame, socket, reply }) => {
    const message = frame.message;
    if (message.type === 'hd_import_begin') {
      owner = socket;
      assert.equal(message.profileId, 'fr');
      assert.equal(message.replace, false);
      reply({ token: 'upload', chunkBytes: 7 });
    } else {
      assert.equal(owner, socket);
      assert.equal(message.token, 'upload');
      if (message.type === 'hd_import_chunk') {
        assert.equal(message.offset, offset);
        const chunk = Buffer.from(message.data, 'base64');
        chunks.push(chunk); offset += chunk.length;
        reply({ received: offset });
      } else reply({ report: { ok: true, title: 'fixture' } });
    }
  });
  const result = await importDictionary(relay, { path, profileId: 'fr' });
  assert.equal(result.report.title, 'fixture');
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.deepEqual(await readFile(path), bytes);
});
