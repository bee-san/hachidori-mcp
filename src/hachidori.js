// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { TARGET, RelayError } from './relay.js';
import { findDictionary, importDictionary } from './dictionaries.js';

export class Hachidori {
  constructor(relay) { this.relay = relay; this.mutations = Promise.resolve(); }
  // Serialize this client's read/modify/write workflows; the host's revision
  // check still protects against Settings tabs and other MCP processes.
  mutate(run) {
    const next = this.mutations.then(run, run);
    this.mutations = next.catch(() => {});
    return next;
  }
  describe(profileId, signal) {
    return this.relay.call(TARGET, 'hd_mcp_describe', { ...(profileId ? { profileId } : {}) }, { signal });
  }
  updateSettings({ profileId, baseRevision, options, packSettings }, signal) {
    return this.mutate(async () => {
      const result = await this.relay.call(TARGET, 'hd_mcp_options_write', { profileId, baseRevision, options, packSettings }, { mutating: true, signal });
      return { saved: true, revision: result.options.revision, profileId, changedKeys: Object.keys(options) };
    });
  }
  saveScript({ id = randomUUID(), baseRevision, ...script }, signal) {
    // Compile only. User JavaScript runs in Hachidori's user-script world,
    // never in the MCP process, and supports a top-level return.
    if (script.javascript !== undefined) new Script(`(function () {\n${script.javascript}\n})`);
    return this.mutate(async () => {
      const result = await this.relay.call(TARGET, 'hd_mcp_user_script_write', { id, baseRevision, script }, { mutating: true, signal });
      return { saved: true, id, revision: result.options.revision,
        instruction: 'JavaScript runs on the next page load. Browser permission may need enabling; check hachidori_get_settings for userScriptRuntime. CSS applies to the next popup.' };
    });
  }
  deleteScript({ id, baseRevision }, signal) {
    return this.mutate(async () => {
      const result = await this.relay.call(TARGET, 'hd_mcp_user_script_write', { id, baseRevision, remove: true }, { mutating: true, signal });
      return { removed: id, revision: result.options.revision };
    });
  }
  selectProfile({ profileId, baseRevision, autoSwitch }, signal) {
    return this.mutate(() => this.relay.call(TARGET, 'hd_mcp_select_profile', { profileId, baseRevision, autoSwitch }, { mutating: true, signal }));
  }
  importDictionary(args, signal) { return this.mutate(() => importDictionary(this.relay, args, { signal })); }

  setupLanguage({ language, definitionLanguage = 'en', dictionaryUrls, activate = true }, signal) {
    return this.mutate(async () => {
      const completed = [];
      try {
        let state = await this.describe(undefined, signal);
        const term = language.trim().toLocaleLowerCase();
        const pack = state.languages.find(pack => [pack.code, pack.name, pack.nativeName].some(name => name?.toLocaleLowerCase() === term));
        if (!pack) throw new Error(`Unsupported language: ${language}. Use hachidori_list_languages.`);
        const exists = state.profiles.some(profile => profile.id === pack.code);
        const existing = exists ? await this.describe(pack.code, signal) : null;
        const usable = existing?.dictionaries.some(dictionary => dictionary.enabled && dictionary.termCount > 0);
        // Resolve the public catalogue before making any changes. An explicit []
        // prepares only the profile; omitted URLs install a dictionary if needed.
        const recommended = dictionaryUrls === undefined && !usable
          ? await findDictionary(pack.code, definitionLanguage, { signal }) : null;
        const urls = dictionaryUrls ?? (recommended ? [recommended.url] : []);
        for (const url of urls) {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Dictionary URLs must use HTTPS without embedded credentials.');
        }
        if (!exists) {
          await this.relay.call('hoshidicts-offscreen', 'hd_profile_add', { language: pack.code, copyFrom: state.profileId }, { mutating: true, signal, timeoutMs: this.relay.importTimeoutMs });
          completed.push('profile-created');
        }
        state = await this.describe(pack.code, signal);
        await this.relay.call(TARGET, 'hd_mcp_options_write', { profileId: pack.code, baseRevision: state.revision,
          options: { experimental: { multipleLanguages: true } } }, { mutating: true, signal });
        completed.push('multiple-languages-enabled');
        for (const url of urls) {
          await importDictionary(this.relay, { url, profileId: pack.code }, { signal });
          completed.push(`dictionary-imported:${url}`);
        }
        state = await this.describe(pack.code, signal);
        if (activate) {
          await this.relay.call(TARGET, 'hd_mcp_select_profile', { profileId: pack.code, baseRevision: state.selection.revision,
            autoSwitch: false }, { mutating: true, signal });
          completed.push('active-on-host');
        }
        state = await this.describe(pack.code, signal);
        return { language: pack.code, profileId: pack.code, activeProfileId: state.activeProfileId, completed,
          readyForLookups: state.dictionaries.some(dictionary => dictionary.enabled && dictionary.termCount > 0),
          dictionaries: state.dictionaries.map(({ id, title, termCount, enabled }) => ({ id, title, termCount, enabled })),
          recommendedDictionary: recommended,
          note: 'Language selection applies to the sharing host browser. Linked browsers keep their own language selection.' };
      } catch (error) {
        throw new RelayError(error.message, { ...error.details, completed,
          nextStep: 'Read hachidori_get_settings before retrying. Completed steps are retained; setup is not a transaction across profile creation and dictionary downloads.' });
      }
    });
  }
}
