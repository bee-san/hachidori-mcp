# Hachidori MCP

Let your AI configure [Hachidori](https://github.com/bee-san/hachidori):

> Set up French for me, then make a userscript that highlights the popup's first definition.

The AI writes the script and calls this server's tools to install it. Settings,
language profiles and dictionary imports go through Hachidori's own validated,
revisioned save paths. This server does not edit browser profile files or execute
generated JavaScript in Node.

## Requirements

- Node.js **22.15 or later**.
- Hachidori with the **`mcp-configuration-v1`** capability. The companion extension
  change is in [Hachidori PR #746](https://github.com/bee-san/hachidori/pull/746).
  Until that change ships, load the extension from that PR.
- [Hachidori Relay](https://github.com/bee-san/hachidori-anki), installed in Anki,
  with Anki and your sharing browser open. The existing relay is sufficient;
  this server does not need a new Anki add-on build or AnkiConnect.
- Settings → Sharing must say **Sharing through Anki**. Hachidori starts sharing
  once it has a dictionary: on an empty installation, first import one dictionary
  in Hachidori. Only one browser can be the sharing host on a relay port.

## Install and connect

```sh
git clone https://github.com/bee-san/hachidori-mcp.git
cd hachidori-mcp
npm ci
```

Add this to your MCP client's server configuration (for example Claude Desktop,
Cursor, or another client that can launch a local stdio MCP server):

```json
{
  "mcpServers": {
    "hachidori": {
      "command": "node",
      "args": ["/absolute/path/to/hachidori-mcp/src/cli.js"]
    }
  }
}
```

Use your actual absolute path; on Windows it can be
`C:/Users/you/hachidori-mcp/src/cli.js`. Restart the client after adding it.
No build step or AI API key is needed. This server uses **stdio**, so it belongs
on the computer that can reach your relay; it is not a hosted HTTP connector URL.
Only MCP messages are written to stdout during normal operation.

The default relay is `ws://127.0.0.1:8771/link`. If you changed the sharing port,
add an environment entry to the server configuration:

```json
"env": { "HACHIDORI_RELAY_URL": "ws://127.0.0.1:8871/link" }
```

An explicitly configured network relay also works if the host's **Also with my
other computers** switch permits it. The relay's existing access rules apply;
there is no additional MCP HTTP listener or independently exposed settings API.

## What you can ask

- “Set up French with English definitions.”
- “Use German, but keep my Japanese settings.”
- “Make the popup wider and turn off autoplay.”
- “Change my French Anki deck to French Mining.”
- “Make a CSS userscript for the popup, and install it.”
- “Edit that userscript, disable it, or remove it.”
- “Import this Yomitan ZIP into my French profile.”

`setup_language` accepts names and codes from the host's live language registry.
It adds a missing profile, enables Multiple languages, imports a dictionary if
there is no enabled term dictionary, and selects it on the **sharing browser**.
English definitions are the default. It resolves availability from
[Wiktionary-to-Yomitan's live catalogue](https://yomidevs.github.io/wiktionary-to-yomitan/download/)
using that project's documented download layout. Supply `dictionaryUrls` to use
other HTTPS Yomitan ZIPs, or `[]` to prepare only the profile. A repeat setup uses
an existing usable dictionary. The other browsers linked to Hachidori retain
their own lookup-language selections.

Generated JavaScript is compiled to check syntax, then saved as a Hachidori
userscript. **Chrome's Allow User Scripts or Firefox's Allow user scripts
permission must be enabled by the user once.** Reload open pages after changing
JavaScript. CSS applies to the next popup and needs no user-script permission.
Saving a script is distinct from proving it has run on a particular page.
The server provides the AI a [userscript guide](docs/userscripts.md), both as a
tool and an MCP resource.

## Tools

| Tool | Purpose |
| --- | --- |
| `hachidori_get_settings` | Current settings, profile, revisions and userscript registration; optional key filter |
| `hachidori_describe_settings` | Live defaults, valid enum choices, ranges, scope, themes and pack settings |
| `hachidori_update_settings` | Patch settings or pack settings using the latest revision |
| `hachidori_list_languages` | Supported packs and configured profiles |
| `hachidori_setup_language` | Add, provision and activate a language |
| `hachidori_select_language` | Select the host's existing profile and automatic switching |
| `hachidori_list_dictionaries` | Installed dictionaries for a profile |
| `hachidori_import_dictionary` | Stream an HTTPS download or local ZIP through the relay's chunk upload |
| `hachidori_list_userscripts` | IDs, names, sizes and optional source code |
| `hachidori_save_userscript` | Add, edit or toggle one script without replacing the others |
| `hachidori_delete_userscript` | Delete one saved script |
| `hachidori_userscript_guide` | Authoring API, CSS scope, permission and reload rules |

The `configure-language` prompt combines setup with an optional userscript
request. `hachidori://userscript-guide` is the corresponding guide resource.

## Writes and failures

Read settings first. For settings and scripts, pass the returned `revision` as
`baseRevision`; language selection instead uses `selection.revision`. A stale
revision is refused, so an open Settings tab is not silently overwritten.
Nested objects merge, arrays replace, and omitted values stay as they were.
Use the dedicated script tool instead of replacing the `userScripts` array.
Credentials are redacted in tool results and merged on the host, so the AI need
not receive or repeat existing Anki keys. Never send a redaction placeholder
back as a setting value. Anki flat fields update the first Template; a supplied
`anki.templates` array replaces the complete Template list.

Failed tools return MCP `isError`. Disconnects and timeouts after a write say
that its outcome is unknown; the server **never automatically replays a write**.
Read current state before retrying. Language setup reports completed steps if a
later download or save fails; successful earlier steps remain applied.

Dictionary downloads stream through a temporary file which is removed on
success or failure. They are imported in chunks on one relay session, with
`replace: false` by default. A catalogue request has a 30-second deadline;
imports have a five-minute deadline. For large dictionaries, configure your
MCP client's tool timeout to allow that time. Local source files are never removed.
The server ignores relay storage snapshots and broadcasts instead of returning
personal dictionary text, lookup history or known-word lists to the AI.

If connection fails, check Anki, the browser and Settings → Sharing. An older
Hachidori gets an explicit compatibility error. If script registration is
unavailable, enable the browser permission and reload the page.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

The tests use the official MCP client against the shipped stdio CLI and real
WebSocket connections. The optional end-to-end suite also uses the actual
Python relay and Chromium extension, with fixture dictionaries:

```sh
# Check out compatible hachidori and hachidori-anki beside this repository.
npm ci --prefix ../hachidori/test/tooling
node ../hachidori/test/run.mjs install-chrome
npm run test:integration
```

Set `HACHIDORI_PATH`, `HACHIDORI_ANKI_PATH`, or `HACHIDORI_CHROME` for other
locations. The integration suite creates a temporary browser profile and does
not touch your existing installation. CI pins the compatible extension commit;
advance that pin when changing the bridge protocol.

GPL-3.0-or-later. Dictionary and generated-script licences are independent.
