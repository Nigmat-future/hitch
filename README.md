```text
 ██   ██ ██ ████████  ██████ ██   ██
 ██   ██ ██    ██    ██      ██   ██
 ███████ ██    ██    ██      ███████
 ██   ██ ██    ██    ██      ██   ██
 ██   ██ ██    ██     ██████ ██   ██

────────────────────────────────────────────────────────────────────────
 hitch the providers you already have to Pi and Oh My Pi
 scan → pick → write   ::   nothing leaves this machine
────────────────────────────────────────────────────────────────────────
```

<p align="center">
  <strong>You have already typed that base URL and key into Claude Code, Codex, OpenCode, Factory or CC Switch. Don't type it again.</strong><br />
  hitch reads the provider settings other AI tools keep on your machine and connects them to <a href="https://github.com/badlogic/pi-mono">Pi</a> and <a href="https://github.com/can1357/oh-my-pi">Oh My Pi</a>, from a command or from a clickable local panel.
</p>

<p align="center">
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-00E676?style=for-the-badge&labelColor=0D1117">
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022-00E5FF?style=for-the-badge&labelColor=0D1117&logo=node.js&logoColor=00E5FF">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/deps-0-00E676?style=for-the-badge&labelColor=0D1117">
  <img alt="No network" src="https://img.shields.io/badge/network-none%20by%20default-A78BFA?style=for-the-badge&labelColor=0D1117">
  <img alt="Proof of concept" src="https://img.shields.io/badge/status-proof__of__concept-F5A524?style=for-the-badge&labelColor=0D1117">
</p>

<p align="center">
  <a href="#01--the-problem"><b>Problem</b></a> ·
  <a href="#02--quick-start"><b>Quick start</b></a> ·
  <a href="#03--the-panel"><b>Panel</b></a> ·
  <a href="#04--how-keys-are-handled"><b>Keys</b></a> ·
  <a href="#05--what-gets-written"><b>Output</b></a> ·
  <a href="#06--command-reference"><b>Reference</b></a> ·
  <a href="#07--privacy"><b>Privacy</b></a>
</p>

## `01` · The problem

Every AI coding tool wants the same three things for a custom provider: a base URL, an API style and a key. Pi and OMP want them in `models.json` / `models.yml`, at the right indentation, with the right field names, next to whatever is already there.

```text
 ~/.claude/settings.json ─┐
 ~/.codex/config.toml ────┤                       ┌─ ~/.pi/agent/models.json
 opencode.json + auth ────┼──▶  hitch  ──▶  pick  ┤
 ~/.factory/settings.json ┤                       └─ ~/.omp/agent/models.yml
 cc-switch.db ────────────┘
```

Tools like CC Switch handle this for Claude Code and Codex. For Pi, and especially for OMP, you are back to editing YAML by hand. hitch closes that gap.

<table>
<tr><th align="left">By hand</th><th align="left">With <code>hitch</code></th></tr>
<tr><td>Find where each tool stores its endpoint</td><td><b>One scan lists every connectable provider</b></td></tr>
<tr><td>Work out the models.yml field names</td><td><b>Correct Pi / OMP entries, generated</b></td></tr>
<tr><td>Paste the key into another file</td><td><b>Reference the key where it already lives</b></td></tr>
<tr><td>Hope you did not break the file</td><td><b>Backup before every write, one-command undo</b></td></tr>
<tr><td>Open an editor</td><td><b>Or open the panel and click</b></td></tr>
</table>

## `02` · Quick start

### Requirements

| | |
| --- | --- |
| **Runtime** | [Node.js](https://nodejs.org/) 22 or newer |
| **Targets** | Pi and/or Oh My Pi installed (either is fine) |
| **Network** | none, unless you ask for model discovery |

### Install

**Inside Pi** (from the [Pi package catalog](https://pi.dev/packages))

```console
$ pi install npm:pi-hitch
```

or straight from this repository, no registry involved:

```console
$ pi install git:github.com/Nigmat-future/hitch
```

That adds three commands to Pi:

| Command | What it does |
| --- | --- |
| `/hitch [omp] [ids…]` | Scan, pick a provider (or all), confirm, write it to Pi (or OMP), and refresh `/model`. |
| `/hitch-ui` | Open the panel in your browser. It stops when you click Quit or close Pi. |
| `/hitch-undo [omp]` | Restore the models file from hitch's last backup. |

The extension runs the same CLI in a child process, so everything under [Privacy](#07--privacy) applies unchanged.

**As a standalone command.** The installers download straight from this repository. No package manager, no registry.

**macOS, Linux, WSL**

```console
$ curl -fsSL https://raw.githubusercontent.com/Nigmat-future/hitch/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/Nigmat-future/hitch/main/install.ps1 | iex
```

The script checks for Node.js 22+, downloads one archive from github.com over HTTPS, unpacks it, and puts a `hitch` launcher on your PATH (`~/.local/bin` on macOS/Linux, `%LOCALAPPDATA%\hitch\bin` on Windows). It does not touch any AI tool config.

Prefer to read it first? Download, inspect, then run:

```console
$ curl -fsSLO https://raw.githubusercontent.com/Nigmat-future/hitch/main/install.sh
$ less install.sh && sh install.sh
```

| | macOS / Linux | Windows |
| --- | --- | --- |
| **Update** | run the install command again | run the install command again |
| **Pin a version** | `HITCH_VERSION=0.1.0 sh install.sh` | `$env:HITCH_VERSION="0.1.0"` before running |
| **Uninstall** | `curl -fsSL …/install.sh \| sh -s -- --uninstall` | `$env:HITCH_UNINSTALL="1"` before running |

Or skip the installer entirely: `git clone https://github.com/Nigmat-future/hitch.git` and run `node hitch/bin/hitch.js`.

### Three commands

```console
$ hitch                       # what is on this machine?
id              api               endpoint                      key                     models  in pi   in omp
--------------  ----------------  ----------------------------  ----------------------  ------  ------  -------
claude/relay    anthropic         https://api.relay.com         stays in settings.json  2               ✓ relay
codex/proxy     openai-responses  https://proxy.example.com/v1  $PROXY_KEY              1
opencode/local  openai-chat       http://localhost:11434/v1     $OLLAMA_KEY             1

3 providers from Claude Code 1, Codex CLI 1, OpenCode 1. Nothing left this machine.

$ hitch omp                   # add them to Oh My Pi (shows the plan, asks once)
$ hitch pi codex/proxy        # or just one, to Pi
```

Undo any write with `hitch undo omp` / `hitch undo pi`.

## `03` · The panel

```console
$ hitch ui
hitch panel: http://127.0.0.1:53121/#8f3c…
Bound to 127.0.0.1 only. Press Ctrl+C or click Stop to end it.
```

The panel opens in your browser. Pick **Pi** or **Oh My Pi** at the top, and you see two lists: the providers that tool already has, and the providers hitch found in your other tools.

* **Click any provider to edit it**, including ones you wrote by hand. Name, endpoint, API style, key, models (id, display name, context, max output, thinking, images) and headers are all form fields. Fields hitch does not show, such as `cost` or `compat`, are kept exactly as they are.
* **Add provider** opens the same form empty, for endpoints no other tool knows about.
* **Review & add** opens the form pre-filled from another tool, so you can rename it, trim models or change how the key is handled before anything is written. Tick several and press **Add as they are** to skip the review.
* **Fetch from endpoint** asks the provider's `/models` route for its model list and lets you pick from it.
* The bottom of the form shows exactly what will be written, with keys masked. Every save makes a backup, and the confirmation toast has an **Undo** button.

Keys are never sent to the page. An existing key is shown as where it lives (`$VAR`, helper command, saved in file), and a key you paste goes to the local server once, straight into the file.

The server binds to loopback, uses a random per-run token, refuses other origins, serves one inline page with no external assets, and has no route that returns a key value.

## `04` · How keys are handled

hitch treats a key as something that already has a home. By default the target file gets a *reference*, never a copy:

| Where the key lives | What Pi / OMP get | Notes |
| --- | --- | --- |
| an environment variable (Codex `env_key`, OpenCode `{env:X}`, Factory `${X}`) | `apiKey: "$X"` | Pi and OMP expand `$VAR` themselves |
| a helper command (Claude Code `apiKeyHelper`) | `apiKey: "!your-command"` | run by Pi / OMP at request time |
| a literal in another tool's file (Claude settings, OpenCode auth.json, Factory, CC Switch) | `apiKey: "!hitch key claude/relay"` | Pi / OMP call hitch, hitch reads the original file. One copy of the secret, ever. |

Pass `--keys copy` to put the actual value into the target file instead, or `--keys none` to write the provider without a key and log in from inside Pi / OMP. The `!hitch key` form needs `hitch` on the `PATH` of the shell that launches Pi or OMP, which the install scripts take care of.

## `05` · What gets written

**Pi** (`~/.pi/agent/models.json`): entries are added under `providers`; everything else in the file is preserved.

```json
{
  "providers": {
    "proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "api": "openai-responses",
      "apiKey": "$PROXY_KEY",
      "models": [{ "id": "gpt-5.5" }]
    }
  }
}
```

**Oh My Pi** (`~/.omp/agent/models.yml`): providers hitch adds go into one marked block directly under `providers:`. The rest of the file is kept as text, comments included. When you edit a hand-written provider in the panel, only that provider's own lines are rewritten, and the new text is parsed and compared with what you entered before the file is replaced.

```yaml
providers:
  # BEGIN hitch (managed by hitch; edits inside this block are overwritten)
  relay:
    baseUrl: https://api.relay.com
    api: anthropic-messages
    apiKey: "!hitch key claude/relay"
    models:
      - id: claude-fable-5-1
      - id: claude-haiku-4-5
  # END hitch
  handmade:
    baseUrl: https://hand.example.com
    ...
```

When a source knows the endpoint but not the model ids (Codex and Claude Code only record the model you use), hitch writes what it knows, tells you, and offers `--discover`, which asks the provider's own `/models` endpoint. For OMP it also sets `discovery: { type: proxy }` so OMP can list models itself.

Provider names come from the source (`proxy`) or the endpoint host (`relay`). If a name is taken by a provider hitch did not write, it becomes `relay-claude`; pick your own with `--rename claude/relay=work`.

## `06` · Command reference

| Command | What it does |
| --- | --- |
| `hitch` / `hitch scan` | List connectable providers, with a column per target showing where an endpoint is already configured. `--json` for machine-readable output (always redacted), `--all` to also show providers already connected everywhere or written by hitch. |
| `hitch ui [--port N] [--no-open]` | Start the local panel. |
| `hitch pi [ids…]` / `hitch omp [ids…]` | Write providers to a target. Ids are `source/name`; substrings work. No ids means everything found. |
| `--keys ref\|copy\|none` | Key handling, see above. Default `ref`. |
| `--discover` | Fetch model ids from each provider's `/models` endpoint. The only network call hitch can make. |
| `--rename <id>=<name>` | Choose the provider name inside the target. Repeatable. |
| `--dry-run` | Print the plan and stop. |
| `-y`, `--yes` | Skip the confirmation prompt. |
| `hitch remove <pi\|omp> [names…\|--all]` | Remove providers hitch wrote. It refuses to touch anything it did not write. |
| `hitch undo <pi\|omp>` | Restore the latest `.bak-hitch-*` backup. |
| `hitch key <id>` | Print one key to stdout for `!hitch key` references. Refuses a terminal unless `--reveal`. |
| `hitch sources` | Every file hitch reads or writes, and whether it exists. |

Environment overrides: `PI_MODELS_PATH`, `OMP_MODELS_PATH`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `HITCH_STATE_DIR`.

## `07` · Privacy

The short version, from [PRIVACY.md](PRIVACY.md):

* hitch reads only the files `hitch sources` lists. No directory walks, no session logs, no `.env` files, no project folders.
* A scan never loads a key value. Records describe *where* a key lives; output is redacted on top of that.
* A key value is read only for `--keys copy`, `hitch key`, and `--discover`, and it goes nowhere except the target file or the provider it belongs to.
* No network by default, no telemetry, no update checks. `test/privacy.test.js` fails the build if any module other than `src/discover.js` and the loopback panel server imports a network API.
* Every write is preceded by a backup next to the file and is atomic. `~/.hitch/state.json` holds provider names only.

Found a hole? See [SECURITY.md](SECURITY.md).

## `08` · Related

* [omp-route](https://github.com/Nigmat-future/omp-route) compiles fallback chains for providers OMP already knows about. hitch is the step before it: getting the providers into OMP in the first place.

## Development

```console
$ git clone https://github.com/Nigmat-future/hitch.git
$ cd hitch
$ node --test
$ node bin/hitch.js sources
```

Zero dependencies, ES modules, `node:test`. Sources live in `src/sources/` (one file per tool), targets in `src/targets/`, the panel in `src/ui/`, the Pi extension in `extensions/`. Try the extension from a checkout with `pi -e ./extensions/hitch.js`.

## License

[MIT](LICENSE)
