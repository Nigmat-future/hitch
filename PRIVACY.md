# Privacy model

hitch reads the provider settings that other AI tools already keep on your
machine and writes them into Pi and Oh My Pi. That is sensitive work, so the
rules below are part of the product, not a policy page. Each one is checked
by `test/privacy.test.js` where a test can check it.

## What hitch reads

Only the files listed by `hitch sources`:

| Tool | File | Why |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`, model names, token or `apiKeyHelper` |
| Codex CLI | `~/.codex/config.toml` | `[model_providers.*]`, default and profile models |
| OpenCode | `~/.config/opencode/opencode.json(c)`, `~/.local/share/opencode/auth.json` | custom providers, keys added with `/connect` |
| Factory Droid | `~/.factory/settings.json`, `~/.factory/config.json` | `customModels` |
| CC Switch | `~/.cc-switch/cc-switch.db` (read-only) | saved Claude / Codex provider profiles |
| Pi | `~/.pi/agent/models.json` | custom providers (so they can go to OMP) |
| Oh My Pi | `~/.omp/agent/models.yml` | custom providers (so they can go to Pi) |
| Shell | a fixed list of `*_API_KEY` / `*_BASE_URL` names | presence only |

hitch never walks directories, never opens session logs, transcripts,
history, caches or `.env` files, and never reads project-level config in the
current folder.

## What hitch keeps in memory

A provider record holds an endpoint, an API style, model ids, non-secret
headers and a *description* of where the key lives (`$VAR`, a helper
command, or "stored in file X"). The key value itself is not loaded during a
scan. `hitch scan --json`, the table view and the panel are therefore safe
by construction, and everything printed still passes through a redaction
filter as a second layer.

## When a key value is touched

Exactly three actions read a key value, all of them explicit:

1. `hitch pi|omp --keys copy` reads the value at the moment of writing and
   puts it in the target file. It is not logged or kept.
2. `hitch key <id>` prints one value to stdout so that Pi/OMP can resolve a
   `!hitch key <id>` reference at request time. It refuses to print to a
   terminal unless you pass `--reveal`.
3. `--discover` sends the key to the provider's own `/models` endpoint, the
   endpoint the key was issued for, to fetch model ids.

The default (`--keys ref`) never copies a value: the target gets `$VAR`,
`!your-helper-command` or `!hitch key <id>`, so each secret keeps living in
exactly one place.

## Network

hitch makes no network calls unless you pass `--discover`, and then only to
the provider's own base URL. There are no update checks, no telemetry, no
crash reports. `test/privacy.test.js` fails if any source file other than
`src/discover.js` and the local panel server imports a network module.

## The panel

`hitch ui` starts an HTTP server bound to `127.0.0.1` on a random port with
a random per-run token. Requests without the token, with a foreign `Origin`,
or with a `Host` header that is not the loopback address are refused. The
page is one inline HTML file with a strict Content-Security-Policy and no
external assets. The panel has no route that returns a key value.

The editor describes an existing key (`$VAR`, helper command, "saved in
file") instead of showing it, and hides header values that look like
secrets. The live preview masks keys. A key you paste is sent once, to the
local server, when you press Save or Fetch from endpoint; typing in the
field only sends its length for the preview.

## Installing

`install.sh` and `install.ps1` download one archive from github.com over
HTTPS and write a launcher. They send nothing else and read no config. They
are short; read them before running if you prefer.

## What hitch writes

* `~/.pi/agent/models.json` — providers added under `providers`, other keys
  untouched.
* `~/.omp/agent/models.yml` — one clearly marked block directly under
  `providers:`; the rest of the file is kept as text, comments included.
  Editing a hand-written provider in the panel rewrites only that
  provider's lines, and only after the result parses back to what you
  entered.
* `~/.hitch/state.json` — names of the providers hitch wrote per target and
  when. No endpoints, no keys.
* `<file>.bak-hitch-<timestamp>` next to every file before it changes (last
  five kept). `hitch undo` restores the latest.

Writes are atomic (temp file plus rename) and files are created with mode
`0600` where the platform supports it.
