// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Exercise the shipped CLI and SDK, rather than invoking tool callbacks directly.
test('stdio discovery, resources, prompts, validation and clean shutdown', async t => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.js', import.meta.url))], stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 12);
  assert.equal(tools.find(tool => tool.name === 'hachidori_get_settings').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'hachidori_delete_userscript').annotations.destructiveHint, true);
  const guide = await client.callTool({ name: 'hachidori_userscript_guide', arguments: {} });
  assert.match(guide.content[0].text, /hachidori-popup-shown/);
  const resource = await client.readResource({ uri: 'hachidori://userscript-guide' });
  assert.match(resource.contents[0].text, /top-level/);
  const prompt = await client.getPrompt({ name: 'configure-language', arguments: { language: 'French' } });
  assert.match(prompt.messages[0].content.text, /French/);
  const invalid = await client.callTool({ name: 'hachidori_update_settings', arguments: { options: {} } });
  assert.equal(invalid.isError, true);
});
