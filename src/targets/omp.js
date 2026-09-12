// Oh My Pi target: ~/.omp/agent/models.yml. Providers hitch adds live in one
// clearly marked block directly under "providers:". Editing a provider you
// wrote by hand rewrites only that provider's own lines. Everything else in
// the file stays as text, comments included. Every write is re-parsed and
// compared with what was intended before it replaces the file.
import fs from "node:fs";
import { emitYaml, parseYaml } from "../parsers/yaml.js";
import { backup, exists, listBackups, pruneBackups, readText, writeAtomic } from "../fsx.js";
import { paths } from "../paths.js";
import { forgetManaged, loadState, rememberManaged, restoreManaged, saveState, snapshotManaged } from "../state.js";
import { endpointsOf } from "./pi.js";

export const BEGIN = "# BEGIN hitch (managed by hitch; edits inside this block are overwritten)";
export const END = "# END hitch";

const file = () => paths().omp.models;

const splitLines = (text) => String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
const indentOf = (line) => line.match(/^ */)[0].length;

const findBlock = (lines) => {
  const start = lines.findIndex((line) => line.trim() === BEGIN);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === END);
  if (end < 0) throw new Error(`${file()} has a hitch BEGIN marker without an END marker`);
  return { start, end };
};

const findProvidersLine = (lines) => lines.findIndex((line) => /^providers:\s*(#.*)?$/.test(line));

export const readManagedBlock = (text) => {
  const lines = splitLines(text);
  const block = findBlock(lines);
  if (!block) return {};
  const body = lines.slice(block.start + 1, block.end).map((line) => line.replace(/^ {2}/, "")).join("\n");
  const parsed = body.trim() ? parseYaml(body) : {};
  return parsed && typeof parsed === "object" ? parsed : {};
};

const renderBlock = (entries) => {
  const body = Object.keys(entries).length ? emitYaml(entries, 2) : "";
  return [`  ${BEGIN}`, ...(body ? body.replace(/\n$/, "").split("\n") : []), `  ${END}`];
};

// Puts `entries` into the managed block, creating the block and the
// top-level providers key when needed. Returns the new file text.
export const spliceBlock = (text, entries) => {
  const lines = text === null ? [] : splitLines(text);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const block = findBlock(lines);
  const hasEntries = Object.keys(entries).length > 0;
  if (block) {
    lines.splice(block.start, block.end - block.start + 1, ...(hasEntries ? renderBlock(entries) : []));
  } else if (hasEntries) {
    let at = findProvidersLine(lines);
    if (at < 0) {
      const inline = lines.findIndex((line) => /^providers:\s*(\{\s*\}|null|~)\s*(#.*)?$/.test(line));
      if (inline >= 0) {
        lines[inline] = "providers:";
        at = inline;
      } else {
        if (lines.length) lines.push("");
        lines.push("providers:");
        at = lines.length - 1;
      }
    }
    lines.splice(at + 1, 0, ...renderBlock(entries));
  }
  // providers: with no entries left (comments do not count) would read back
  // as null; keep it an empty map.
  const at = findProvidersLine(lines);
  if (at >= 0) {
    const next = lines.slice(at + 1).find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    if (next === undefined || !/^\s/.test(next)) lines[at] = "providers: {}";
  }
  return `${lines.join("\n")}\n`;
};

const KEY_LINE = /^( *)(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-][^:#]*?))\s*:(?=\s|$)/;

const lineKey = (line) => {
  const match = KEY_LINE.exec(line);
  if (!match) return null;
  let name;
  if (match[2] !== undefined) name = JSON.parse(`"${match[2]}"`);
  else if (match[3] !== undefined) name = match[3].replace(/''/g, "'");
  else name = match[4].trim();
  return { indent: match[1].length, name };
};

// Line span [start, end) of a hand-written provider outside hitch's block.
export const findEntrySpan = (lines, name) => {
  const at = findProvidersLine(lines);
  if (at < 0) return null;
  const block = findBlock(lines);
  let childIndent = null;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (block && i === block.start) {
      i = block.end;
      continue;
    }
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const key = lineKey(line);
    if (!key || key.name !== name) continue;
    let end = i + 1;
    while (end < lines.length) {
      if (block && end === block.start) break;
      const next = lines[end];
      const t = next.trim();
      if (t && indentOf(next) <= childIndent) break;
      end += 1;
    }
    while (end - 1 > i && !lines[end - 1].trim()) end -= 1;
    return { start: i, end, indent: childIndent };
  }
  return null;
};

const parseProviders = (text) => {
  if (text === null || !String(text).trim()) return {};
  const data = parseYaml(text);
  const table = data?.providers;
  return table && typeof table === "object" && !Array.isArray(table) ? table : {};
};

const plain = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

// Refuse to write anything that does not read back exactly as intended.
const verify = (nextText, expect) => {
  let providers;
  try {
    providers = parseProviders(nextText);
  } catch (error) {
    throw new Error(`hitch stopped before writing: the result would not parse (${error.message}). Your file is unchanged.`);
  }
  Object.entries(expect.present ?? {}).forEach(([name, spec]) => {
    if (JSON.stringify(providers[name]) !== JSON.stringify(plain(spec))) {
      throw new Error(`hitch stopped before writing: "${name}" would not read back as entered. Your file is unchanged.`);
    }
  });
  (expect.absent ?? []).forEach((name) => {
    if (name in providers) throw new Error(`hitch stopped before writing: "${name}" would still be present. Your file is unchanged.`);
  });
};

const commit = (text) => {
  const path = file();
  const saved = backup(path);
  snapshotManaged("omp", saved);
  writeAtomic(path, text);
  pruneBackups(path);
  return saved;
};

export const ompTarget = {
  id: "omp",
  label: "Oh My Pi",
  file,
  read: () => {
    const path = file();
    const managed = loadState().targets.omp.managed;
    const problems = [];
    let names = new Set();
    let endpoints = new Map();
    try {
      const providers = parseProviders(readText(path));
      names = new Set(Object.keys(providers));
      endpoints = endpointsOf(providers);
    } catch (error) {
      problems.push(`${path}: ${error.message} (hitch can still write its own block)`);
    }
    return { file: path, exists: exists(path), names, endpoints, managed: new Map(Object.entries(managed)), problems };
  },
  listEntries: () => {
    const managed = loadState().targets.omp.managed;
    return Object.entries(parseProviders(readText(file())))
      .filter(([, spec]) => spec && typeof spec === "object" && !Array.isArray(spec))
      .map(([name, spec]) => ({ name, spec, managed: managed[name] ?? null }));
  },
  getEntry: (name) => {
    const spec = parseProviders(readText(file()))[name];
    return spec && typeof spec === "object" ? spec : null;
  },
  saveEntry: ({ originalName = null, name, spec, id = "manual" }) => {
    const text = readText(file());
    const all = parseProviders(text);
    if (originalName && !(originalName in all)) throw new Error(`"${originalName}" is no longer in ${file()}. Rescan and try again.`);
    if (name !== originalName && name in all) throw new Error(`A provider named "${name}" already exists in Oh My Pi.`);
    const block = readManagedBlock(text ?? "");
    let track = null;
    let next;
    if (originalName && originalName in block) {
      const entries = {};
      Object.entries(block).forEach(([key, value]) => {
        entries[key === originalName ? name : key] = key === originalName ? spec : value;
      });
      next = spliceBlock(text, entries);
      track = "rename";
    } else if (originalName) {
      const lines = splitLines(text);
      const span = findEntrySpan(lines, originalName);
      if (!span) throw new Error(`hitch could not locate "${originalName}" in ${file()} safely. Edit that entry by hand.`);
      const body = emitYaml({ [name]: plain(spec) }, span.indent).replace(/\n$/, "").split("\n");
      lines.splice(span.start, span.end - span.start, ...body);
      next = lines.join("\n");
      if (!next.endsWith("\n")) next += "\n";
    } else {
      next = spliceBlock(text, { ...block, [name]: spec });
      track = "add";
    }
    verify(next, { present: { [name]: spec }, absent: originalName && originalName !== name ? [originalName] : [] });
    const saved = commit(next);
    if (track) {
      const state = loadState();
      const managed = state.targets.omp.managed;
      if (track === "rename") {
        const meta = managed[originalName] ?? { id };
        delete managed[originalName];
        managed[name] = { ...meta, at: now() };
      } else managed[name] = { id, at: now() };
      saveState(state);
    }
    return { file: file(), backup: saved, name };
  },
  deleteEntry: (name) => {
    const text = readText(file());
    const all = parseProviders(text);
    if (!(name in all)) throw new Error(`"${name}" is not in ${file()}.`);
    const block = readManagedBlock(text ?? "");
    let next;
    if (name in block) {
      const entries = { ...block };
      delete entries[name];
      next = spliceBlock(text, entries);
    } else {
      const lines = splitLines(text);
      const span = findEntrySpan(lines, name);
      if (!span) throw new Error(`hitch could not locate "${name}" in ${file()} safely. Remove that entry by hand.`);
      lines.splice(span.start, span.end - span.start);
      next = spliceBlock(lines.join("\n"), readManagedBlock(lines.join("\n")));
    }
    const keep = Object.fromEntries(Object.entries(all).filter(([key]) => key !== name));
    verify(next, { present: keep, absent: [name] });
    const saved = commit(next);
    forgetManaged("omp", [name]);
    return { file: file(), backup: saved, removed: [name] };
  },
  apply: (items) => {
    const text = readText(file());
    const entries = readManagedBlock(text ?? "");
    const written = [];
    items.forEach((item) => {
      if (item.action === "skip") return;
      entries[item.name] = item.entry;
      written.push({ name: item.name, id: item.id });
    });
    const next = spliceBlock(text, entries);
    verify(next, { present: Object.fromEntries(written.map((w) => [w.name, entries[w.name]])) });
    const saved = commit(next);
    rememberManaged("omp", written);
    return { file: file(), backup: saved, written: written.map((w) => w.name) };
  },
  remove: (names) => {
    const text = readText(file());
    const entries = readManagedBlock(text ?? "");
    const removed = names.filter((name) => name in entries);
    removed.forEach((name) => delete entries[name]);
    const saved = removed.length ? commit(spliceBlock(text, entries)) : null;
    forgetManaged("omp", names);
    return { file: file(), backup: saved, removed };
  },
  undo: () => {
    const path = file();
    const backups = listBackups(path);
    if (!backups.length) throw new Error(`no hitch backups next to ${path}`);
    const latest = backups[backups.length - 1];
    fs.copyFileSync(latest, path);
    fs.rmSync(latest, { force: true });
    let present = null;
    try {
      present = new Set(Object.keys(readManagedBlock(readText(path) ?? "")));
    } catch {
      // Restored text is the user's; keep the snapshot as the best record.
    }
    restoreManaged("omp", latest, present);
    return { file: path, restoredFrom: latest, remaining: backups.length - 1 };
  },
};
