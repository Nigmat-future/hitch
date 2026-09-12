import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { readSecret, scan, SOURCES } from "./sources/index.js";
import { buildPlan, HITCH_KEY_NOTE, KEY_MODES, materialize } from "./targets/common.js";
import { targetFor, TARGET_LIST } from "./targets/index.js";
import { discoverModels } from "./discover.js";
import { describeKey, endpointKey } from "./model.js";
import { displayPath, paths } from "./paths.js";
import { exists } from "./fsx.js";
import { redactText } from "./redact.js";

const require = createRequire(import.meta.url);
export const VERSION = require("../package.json").version;

const HELP = `hitch ${VERSION} — connect the providers you already have to Pi and Oh My Pi

USAGE
  hitch                       scan this machine and show what can be connected
  hitch ui                    open the local panel in your browser (127.0.0.1 only)
  hitch pi  [ids...]          add providers to Pi   (~/.pi/agent/models.json)
  hitch omp [ids...]          add providers to OMP  (~/.omp/agent/models.yml)
  hitch remove <pi|omp> [names...|--all]
  hitch undo <pi|omp>         restore the last backup hitch made
  hitch key <id>              print one key to stdout (for "!hitch key" references)
  hitch sources               list every file hitch reads, and whether it exists
  hitch scan --json           machine-readable scan (always redacted)
  hitch scan --all            include providers already connected everywhere

OPTIONS (pi / omp)
  --keys ref|copy|none        ref: $VAR / !command / !hitch key (default)
                              copy: put the key value into the target file
                              none: write the provider without a key
  --discover                  ask each provider's own /models endpoint for model ids
  --rename <id>=<name>        choose the provider name inside the target
  --dry-run                   show the plan, write nothing
  -y, --yes                   skip the confirmation prompt

Ids look like codex/myproxy or claude/example. Substrings work: "hitch omp proxy".
Nothing leaves this machine. Details: PRIVACY.md`;

const parseArgs = (argv) => {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      const takesValue = ["keys", "rename", "port"].includes(name);
      if (inline !== undefined) flags[name] = name === "rename" ? [...(flags.rename ?? []), inline] : inline;
      else if (takesValue) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`--${name} needs a value`);
        flags[name] = name === "rename" ? [...(flags.rename ?? []), value] : value;
        i += 1;
      } else flags[name] = true;
    } else if (arg === "-y") flags.yes = true;
    else if (arg === "-h") flags.help = true;
    else if (arg === "-v") flags.version = true;
    else flags._.push(arg);
  }
  return flags;
};

const pad = (text, width) => {
  const s = String(text ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
};

const clip = (text, width) => {
  const s = String(text ?? "");
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
};

const table = (rows, headers) => {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
};

const keyCell = (provider) => {
  const { key } = provider;
  if (key.kind === "env") return key.present ? `$${key.env}` : `$${key.env} (unset)`;
  if (key.kind === "command") return "helper command";
  if (key.kind === "stored") return `stays in ${displayPath(key.where).split("/").pop()}`;
  return "none";
};

// Which target already has each endpoint, under what name. Read once per scan.
export const connectedIn = (providers) => {
  const reads = TARGET_LIST.map((t) => [t.id, t.read()]);
  providers.forEach((p) => {
    p.connected = Object.fromEntries(reads.map(([id, state]) => [id, state.endpoints.get(endpointKey(p.baseUrl, p.api)) ?? null]));
  });
  return providers;
};

const printScan = (result, { out = console.log, all = false } = {}) => {
  const { problems, stats } = result;
  // Providers already present in every target have nowhere new to go; keep
  // the table about what can still be connected.
  const done = result.providers.filter((p) => TARGET_LIST.every((t) => p.connected?.[t.id]));
  const providers = all ? result.providers : result.providers.filter((p) => !done.includes(p));
  if (!providers.length) {
    out(done.length ? "Everything found is already connected to both Pi and OMP." : "No connectable providers found.");
  } else {
    const rows = providers.map((p) => [
      p.id,
      p.api.replace("-messages", "").replace("-completions", "-chat"),
      clip(p.baseUrl, 40),
      keyCell(p),
      p.models.length ? String(p.models.length) : "?",
      p.connected?.pi ? `✓ ${p.connected.pi}` : "",
      p.connected?.omp ? `✓ ${p.connected.omp}` : "",
    ]);
    out(table(rows, ["id", "api", "endpoint", "key", "models", "in pi", "in omp"]));
  }
  const found = stats.filter((s) => s.count > 0).map((s) => `${s.label} ${s.count}`).join(", ");
  out("");
  out(`${result.providers.length} provider${result.providers.length === 1 ? "" : "s"} from ${found || "no sources"}. Nothing left this machine.`);
  if (!all && done.length) out(`${done.length} already connected to both Pi and OMP are hidden (--all shows them).`);
  problems.forEach((problem) => out(`  ! ${redactText(problem)}`));
  const withNotes = providers.filter((p) => p.notes.length || p.alsoIn?.length);
  withNotes.forEach((p) => {
    p.notes.forEach((note) => out(`  · ${p.id}: ${redactText(note)}`));
    if (p.alsoIn?.length) out(`  · ${p.id}: same endpoint also in ${p.alsoIn.join(", ")}`);
  });
};

const selectProviders = (providers, wanted) => {
  if (!wanted.length) return providers;
  const chosen = [];
  const missing = [];
  wanted.forEach((term) => {
    const exact = providers.find((p) => p.id === term);
    const matches = exact ? [exact] : providers.filter((p) => p.id.includes(term) || p.name === term);
    if (!matches.length) missing.push(term);
    matches.forEach((p) => {
      if (!chosen.includes(p)) chosen.push(p);
    });
  });
  if (missing.length) throw new Error(`no provider matches ${missing.map((m) => `"${m}"`).join(", ")} (run \`hitch\` to list ids)`);
  return chosen;
};

const parseRenames = (list = []) => Object.fromEntries(list.map((pair) => {
  const [id, name] = String(pair).split("=", 2);
  if (!id || !name) throw new Error(`--rename expects <id>=<name>, got "${pair}"`);
  return [id, name];
}));

const printPlan = (target, items, out = console.log) => {
  out(`Plan for ${target.label} (${displayPath(target.file())}):`);
  const skipped = items.filter((i) => i.action === "skip");
  items.filter((i) => i.action !== "skip").forEach((item) => {
    const verb = { add: "+ add", update: "~ update" }[item.action];
    const key = item.entry.apiKey === undefined ? "no key" : typeof item.entry.apiKey === "object" ? "key copied" : `apiKey ${item.entry.apiKey}`;
    const models = item.entry.models.length ? `${item.entry.models.length} model${item.entry.models.length === 1 ? "" : "s"}` : item.entry.discovery ? "models via proxy discovery" : "no models";
    out(`  ${pad(verb, 9)} ${pad(item.name, 24)} ${pad(item.provider.api, 20)} ${pad(clip(item.provider.baseUrl, 40), 40)}  ${key}  ${models}`);
    item.warnings.forEach((w) => out(`             ! ${w}`));
  });
  skipped.forEach((item) => out(`  ${pad("- skip", 9)} ${pad(item.id, 24)} ${item.warnings[0] ?? ""}`));
  if (items.some((i) => i.action !== "skip" && i.viaHitch)) out(`\n  ${HITCH_KEY_NOTE}`);
};

const confirm = async (question) => {
  if (!process.stdin.isTTY) throw new Error("not a terminal; pass --yes to confirm non-interactively");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

export const runDiscovery = async (items, log = () => {}) => {
  for (const item of items) {
    if (item.entry.models.length) continue;
    const secret = await readSecret(item.provider);
    const result = await discoverModels(item.provider, secret);
    if (result.models.length) {
      item.entry.models = result.models;
      delete item.entry.discovery;
      log(`  ${item.name}: ${result.models.length} models from ${result.url}`);
    } else {
      item.warnings.push(`discovery failed: ${redactText(result.error)}`);
      log(`  ${item.name}: discovery failed (${redactText(result.error)})`);
    }
  }
};

// Shared by the CLI and the UI server.
export const planFor = async ({ targetId, ids = [], keyMode = "ref", rename = {}, providers }) => {
  if (!(keyMode in KEY_MODES)) throw new Error(`--keys must be one of ${Object.keys(KEY_MODES).join(", ")}`);
  const target = targetFor(targetId);
  const state = target.read();
  // A provider read from the target itself is never written back into it.
  const selected = selectProviders(providers, ids).filter((p) => p.source !== targetId);
  const items = buildPlan({ target: targetId, providers: selected, existingNames: state.names, endpoints: state.endpoints, managed: state.managed, keyMode, rename });
  return { target, state, items };
};

export const applyPlan = async (target, items) => {
  const ready = await materialize(items, readSecret);
  return target.apply(ready);
};

const commandConnect = async (targetId, flags) => {
  const { providers } = await scan();
  const { target, state, items } = await planFor({ targetId, ids: flags._.slice(1), keyMode: flags.keys ?? "ref", rename: parseRenames(flags.rename), providers });
  state.problems.forEach((p) => console.log(`! ${redactText(p)}`));
  if (!items.length) {
    console.log("Nothing to connect. Run `hitch` to see what was found.");
    return 0;
  }
  if (flags.discover) {
    console.log("Asking providers for model lists (this is the only time hitch talks to the network)…");
    await runDiscovery(items, console.log);
  }
  printPlan(target, items);
  const active = items.filter((i) => i.action !== "skip");
  if (flags["dry-run"] || flags.plan) {
    console.log("\nDry run: nothing written.");
    return 0;
  }
  if (!active.length) {
    console.log(`\nNothing to write: everything selected is already in ${target.label}.`);
    return 0;
  }
  if (!flags.yes) {
    const ok = await confirm(`\nWrite ${active.length} provider${active.length === 1 ? "" : "s"} to ${displayPath(target.file())}?`);
    if (!ok) {
      console.log("Cancelled; nothing written.");
      return 1;
    }
  }
  const result = await applyPlan(target, items);
  console.log(`\nWrote ${result.written.length} provider${result.written.length === 1 ? "" : "s"} to ${displayPath(result.file)}.`);
  if (result.backup) console.log(`Backup: ${displayPath(result.backup)}  (undo with \`hitch undo ${targetId}\`)`);
  if (targetId === "omp") console.log("Restart OMP or open /model to pick them up.");
  else console.log("Pi reloads models.json when you open /model.");
  return 0;
};

const commandRemove = async (flags) => {
  const targetId = flags._[1];
  if (!targetId) throw new Error("usage: hitch remove <pi|omp> [names...|--all]");
  const target = targetFor(targetId);
  const state = target.read();
  const managed = [...state.managed.keys()];
  const names = flags.all ? managed : flags._.slice(2);
  if (!names.length) {
    if (!managed.length) console.log(`hitch has not written any providers to ${target.label}.`);
    else console.log(`hitch-managed providers in ${target.label}: ${managed.join(", ")}\nPass names or --all.`);
    return 0;
  }
  const unknown = names.filter((n) => !state.managed.has(n));
  if (unknown.length) throw new Error(`not written by hitch, so not removed: ${unknown.join(", ")}`);
  if (!flags.yes) {
    const ok = await confirm(`Remove ${names.join(", ")} from ${displayPath(target.file())}?`);
    if (!ok) {
      console.log("Cancelled; nothing changed.");
      return 1;
    }
  }
  const result = target.remove(names);
  console.log(`Removed ${result.removed.length} provider${result.removed.length === 1 ? "" : "s"} from ${displayPath(result.file)}.`);
  if (result.backup) console.log(`Backup: ${displayPath(result.backup)}`);
  return 0;
};

const commandUndo = async (flags) => {
  const targetId = flags._[1];
  if (!targetId) throw new Error("usage: hitch undo <pi|omp>");
  const target = targetFor(targetId);
  const result = target.undo();
  console.log(`Restored ${displayPath(result.file)} from ${displayPath(result.restoredFrom)}.`);
  if (result.remaining) console.log(`${result.remaining} older backup${result.remaining === 1 ? "" : "s"} remain.`);
  return 0;
};

const commandKey = async (flags) => {
  const id = flags._[1];
  if (!id) throw new Error("usage: hitch key <id>");
  if (process.stdout.isTTY && !flags.reveal) {
    throw new Error("refusing to print a key to a terminal; pipe it (hitch key id | …) or pass --reveal");
  }
  const { providers } = await scan({ includeManaged: true });
  const provider = providers.find((p) => p.id === id);
  if (!provider) throw new Error(`no provider with id "${id}"`);
  const value = await readSecret(provider);
  if (!value) throw new Error(`no key readable for "${id}" (${describeKey(provider.key)})`);
  process.stdout.write(value);
  return 0;
};

const commandSources = async () => {
  console.log("Files hitch reads (nothing else is opened):\n");
  SOURCES.forEach((source) => {
    source.files().forEach((f) => {
      const present = f.path.startsWith("(") ? "" : exists(f.path) ? "  found" : "  absent";
      console.log(`  ${pad(source.label, 14)} ${pad(displayPath(f.path), 52)}${present}   ${f.role}`);
    });
  });
  console.log("\nFiles hitch writes (only when you run pi / omp / remove / undo):\n");
  TARGET_LIST.forEach((t) => console.log(`  ${pad(t.label, 14)} ${pad(displayPath(t.file()), 52)}${exists(t.file()) ? "  found" : "  absent"}`));
  console.log(`  ${pad("hitch", 14)} ${displayPath(paths().hitch.state)}   names of providers hitch wrote, for remove/undo`);
  return 0;
};

export const main = async (argv) => {
  const flags = parseArgs(argv);
  const command = flags._[0];
  if (flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (flags.help || command === "help") {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case undefined:
    case "scan": {
      const result = await scan({ includeManaged: Boolean(flags.all) });
      connectedIn(result.providers);
      if (flags.json) {
        const safe = result.providers.map(({ provider, secretRef, ...rest }) => rest);
        console.log(JSON.stringify({ version: VERSION, providers: safe, problems: result.problems.map(redactText), sources: result.stats }, null, 2));
        return 0;
      }
      printScan(result, { all: Boolean(flags.all) });
      if (command === undefined && process.stdout.isTTY) console.log("\nNext: `hitch omp`, `hitch pi`, or `hitch ui` for the clickable panel.");
      return 0;
    }
    case "pi":
    case "omp":
      return commandConnect(command, flags);
    case "remove":
    case "rm":
      return commandRemove(flags);
    case "undo":
      return commandUndo(flags);
    case "key":
      return commandKey(flags);
    case "sources":
      return commandSources();
    case "ui": {
      const { serve } = await import("./ui/server.js");
      return serve({ port: flags.port ? Number(flags.port) : 0, open: !flags["no-open"] });
    }
    default:
      throw new Error(`unknown command "${command}" (try hitch --help)`);
  }
};
