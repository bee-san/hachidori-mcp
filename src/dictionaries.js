// SPDX-License-Identifier: GPL-3.0-or-later
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const CATALOGUE = 'https://yomidevs.github.io/wiktionary-to-yomitan/release_metadata_yomitan.json';
export const DOWNLOAD_BASE = 'https://huggingface.co/datasets/daxida/wty-release/resolve/main/latest/dict';

export async function findDictionary(language, definitionLanguage = 'en', { fetcher = fetch, signal } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetcher(CATALOGUE, { signal });
  if (!response.ok) throw new Error(`Dictionary catalogue returned HTTP ${response.status}.`);
  const metadata = await response.json();
  const size = metadata.dicts?.main?.sources?.[language]?.targets?.[definitionLanguage];
  if (!size) throw new Error(`No Wiktionary ${language} → ${definitionLanguage} dictionary is currently available. Supply dictionaryUrls or choose another definitionLanguage.`);
  return { language, definitionLanguage, size, date: metadata.date,
    url: `${DOWNLOAD_BASE}/${language}/${definitionLanguage}/wty-${language}-${definitionLanguage}.zip`,
    source: CATALOGUE, licence: 'See the dictionary index and upstream Wiktionary attribution.' };
}

// Download to disk and upload sequentially through the existing chunk protocol;
// neither the whole archive nor its base64 representation is held in memory.
export async function importDictionary(relay, { url, path, profileId, replace = false }, { signal, fetcher = fetch } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(relay.importTimeoutMs)]) : AbortSignal.timeout(relay.importTimeoutMs);
  if (Boolean(url) === Boolean(path)) throw new Error('Supply exactly one of url or path.');
  let temporary;
  let file = path;
  try {
    if (url) {
      const address = new URL(url);
      if (address.protocol !== 'https:' || address.username || address.password) throw new Error('Dictionary URLs must use HTTPS without embedded credentials.');
      temporary = await mkdtemp(join(tmpdir(), 'hachidori-mcp-'));
      file = join(temporary, 'dictionary.zip');
      const response = await fetcher(address, { signal });
      if (!response.ok) throw new Error(`Dictionary download returned HTTP ${response.status}.`);
      if (new URL(response.url || address).protocol !== 'https:') throw new Error('Dictionary download redirected away from HTTPS.');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file), { signal });
    } else if (!isAbsolute(path)) throw new Error('Use an absolute path to a local Yomitan ZIP.');
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) throw new Error('The dictionary must be a nonempty ZIP file.');
    return await relay.session(async ({ request }) => {
      const target = 'hachidori-linked-import';
      const begun = await request(target, 'hd_import_begin', { fileName: url ? 'dictionary.zip' : basename(file), size: info.size, replace, profileId });
      if (!Number.isSafeInteger(begun.chunkBytes) || begun.chunkBytes <= 0 || typeof begun.token !== 'string') throw new Error('Invalid upload handshake.');
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(begun.chunkBytes, info.size));
        for (let offset = 0; offset < info.size;) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
          if (!bytesRead) throw new Error('Dictionary file changed during upload.');
          const reply = await request(target, 'hd_import_chunk', { token: begun.token, offset, data: buffer.subarray(0, bytesRead).toString('base64') });
          offset += bytesRead;
          if (reply.received !== offset) throw new Error('Hachidori acknowledged an unexpected upload offset.');
        }
        const result = await request(target, 'hd_import_commit', { token: begun.token }, { mutating: true, timeoutMs: relay.importTimeoutMs });
        if (result.report?.ok === false || result.report?.error) throw new Error(result.report.error || 'Dictionary import failed.');
        return result;
      } catch (error) {
        await request(target, 'hd_import_abort', { token: begun.token }).catch(() => {});
        throw error;
      } finally { await handle.close(); }
    }, { signal });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
