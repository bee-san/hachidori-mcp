#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { relayAddress } from './relay.js';

if (process.argv.includes('--help')) {
  process.stdout.write('Hachidori MCP 0.1.0\n\nStart without arguments from an MCP client. Transport: stdio.\nHACHIDORI_RELAY_URL defaults to ws://127.0.0.1:8771/link.\nKeep Anki (Hachidori Relay) and the sharing Hachidori browser open.\n');
} else if (process.argv.includes('--version')) {
  process.stdout.write('0.1.0\n');
} else {
  relayAddress(process.env.HACHIDORI_RELAY_URL);
  const handle = serveStdio(() => createServer(), { onerror: error => console.error(error.message) });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void handle.close().finally(() => process.exit(0)); });
}
