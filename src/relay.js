// SPDX-License-Identifier: GPL-3.0-or-later
import WebSocket from 'ws';

export const CAPABILITY = 'mcp-configuration-v1';
export const TARGET = 'hachidori-mcp';
const ORIGIN = 'hoshi://hoshidicts';
const HELP = 'Keep Anki with Hachidori Relay and the sharing Hachidori browser open. Check Settings → Sharing and HACHIDORI_RELAY_URL.';

export class RelayError extends Error {
  constructor(message, details = {}) { super(message); this.details = details; }
}

export function relayAddress(value = 'ws://127.0.0.1:8771/link') {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/link' || url.username || url.password || url.search || url.hash) {
    throw new Error('HACHIDORI_RELAY_URL must be a ws:// or wss:// address ending in /link, without credentials, query or fragment.');
  }
  return url.href;
}

// A fresh session per operation avoids cached settings and the host's deliberate
// disconnect when adding the first language. Sent mutations are never replayed.
export class Relay {
  constructor({ url, timeoutMs = 30_000, importTimeoutMs = 300_000 } = {}) {
    this.url = relayAddress(url);
    this.timeoutMs = timeoutMs;
    this.importTimeoutMs = importTimeoutMs;
  }

  async session(run, { signal } = {}) {
    signal?.throwIfAborted();
    const socket = new WebSocket(this.url, { origin: ORIGIN, handshakeTimeout: this.timeoutMs, maxPayload: 0 });
    const pending = new Map();
    let nextId = 0;
    let failure;
    let helloResolve, helloReject;
    const hello = new Promise((resolve, reject) => { helloResolve = resolve; helloReject = reject; });
    const fail = error => {
      failure ??= error;
      helloReject(error);
      for (const waiter of pending.values()) waiter.reject(new RelayError(
        `${error.message}${waiter.mutating ? ' The write outcome is unknown; read the current state before retrying.' : ''}`,
        { outcomeUnknown: waiter.mutating }));
      pending.clear();
    };
    const request = (target, type, fields = {}, { mutating = false, timeoutMs = this.timeoutMs } = {}) => {
      if (failure) return Promise.reject(failure);
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new RelayError(`Relay disconnected. ${HELP}`));
      const id = `mcp-${++nextId}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RelayError(`Hachidori did not answer ${type} in time.${mutating ? ' The write outcome is unknown; read the current state before retrying.' : ''}`,
            { outcomeUnknown: mutating }));
        }, timeoutMs);
        pending.set(id, { mutating, resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ kind: 'request', id, message: { ...fields, target, type, requestId: id } }), error => {
          if (error) fail(new RelayError(`Relay send failed: ${error.message}`));
        });
      });
    };
    const abort = () => { fail(new RelayError('Hachidori operation cancelled.')); socket.terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', protocol: 1, version: 'hachidori-mcp/0.1.0',
      name: 'Hachidori MCP', capabilities: [CAPABILITY, 'linked-import-v1', 'linked-anki-v1', 'linked-anki-v2'] })));
    socket.on('error', error => fail(new RelayError(`Cannot connect to the Hachidori relay: ${error.message}. ${HELP}`)));
    socket.on('close', () => fail(new RelayError(`The Hachidori relay disconnected. ${HELP}`)));
    socket.on('message', data => {
      try {
        const frame = JSON.parse(data.toString());
        if (frame.kind === 'ping') socket.send(JSON.stringify({ kind: 'pong' }));
        else if (frame.kind === 'bye') fail(new RelayError(`Hachidori ended the session: ${frame.reason}`));
        else if (frame.kind === 'hello') {
          if (frame.protocol !== 1 || !frame.capabilities?.includes(CAPABILITY)) {
            fail(new RelayError(`Update Hachidori to a build with ${CAPABILITY} (see the README).`));
          } else helloResolve(frame);
        } else if (frame.kind === 'reply') {
          const waiter = pending.get(frame.id);
          if (!waiter) return;
          pending.delete(frame.id);
          const response = frame.response;
          if (!response || response.ok === false || response.error) {
            waiter.reject(new RelayError(response?.error || 'Hachidori rejected the request.',
              { conflict: response?.conflict === true }));
          } else waiter.resolve(response);
        }
        // Storage pushes may contain personal dictionaries/history. Never expose
        // or cache them: tools read only their explicit configuration response.
      } catch (error) { fail(new RelayError(`Invalid relay frame: ${error.message}`)); }
    });
    const timer = setTimeout(() => fail(new RelayError(`Hachidori did not complete the handshake. ${HELP}`)), this.timeoutMs);
    try {
      await hello;
      clearTimeout(timer);
      // A native client does not render packs. Ask the host for its complete
      // pack list before opting in, including on a Japanese-only installation.
      const first = await request('hoshidicts-worker', 'hd_language_profiles_opt_in', { languages: [] });
      const accepted = await request('hoshidicts-worker', 'hd_language_profiles_opt_in', { languages: first.hostLanguages });
      if (accepted.optIn !== 'accepted') throw new RelayError('Hachidori refused language-profile negotiation; update Hachidori.');
      return await run({ request });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.terminate();
    }
  }

  call(target, type, fields = {}, options = {}) {
    return this.session(session => session.request(target, type, fields, options), options);
  }
}
