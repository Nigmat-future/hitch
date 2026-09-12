// Pi target: ~/.pi/agent/models.json. Providers land under "providers";
// every other key in the file is preserved, and provider order is kept.
import fs from "node:fs";
import { parseJsonc } from "../parsers/json.js";
import { backup, exists, listBackups, pruneBackups, readText, writeAtomic } from "../fsx.js";
import { paths } from "../paths.js";
import { forgetManaged, loadState, rememberManaged, restoreManaged, saveState, snapshotManaged } from "../state.js";
import { endpointKey } from "../model.js";

const file = () => paths().pi.models;

export const endpointsOf = (providers) => {
  const map = new Map();
  Object.entries(providers ?? {}).forEach(([name, spec]) => {
    const baseUrl = spec && typeof spec === "object" ? spec.baseUrl ?? spec.base_url : null;
    if (baseUrl && !map.has(endpointKey(baseUrl, spec.api))) map.set(endpointKey(baseUrl, spec.api), name);
  });
  return map;
};

const load = () => {
  const text = readText(file());
  if (text === null) return { providers: {} };
  const data = parseJsonc(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file()} is not a JSON object`);
  if (!data.providers || typeof data.providers !== "object" || Array.isArray(data.providers)) data.providers = {};
  return data;
};

const writeData = (data) => {
  const path = file();
  const saved = backup(path);
  snapshotManaged("pi", saved);
  writeAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
  pruneBackups(path);
  return saved;
};

const now = () => new Date().toISOString();

export const piTarget = {
  id: "pi",
  label: "Pi",
  file,
  read: () => {
    const path = file();
    const managed = loadState().targets.pi.managed;
    try {
      const data = load();
      return { file: path, exists: exists(path), names: new Set(Object.keys(data.providers)), endpoints: endpointsOf(data.providers), managed: new Map(Object.entries(managed)), problems: [] };
    } catch (error) {
      return { file: path, exists: exists(path), names: new Set(), endpoints: new Map(), managed: new Map(Object.entries(managed)), problems: [error.message] };
    }
  },
  listEntries: () => {
    const managed = loadState().targets.pi.managed;
    return Object.entries(load().providers)
      .filter(([, spec]) => spec && typeof spec === "object" && !Array.isArray(spec))
      .map(([name, spec]) => ({ name, spec, managed: managed[name] ?? null }));
  },
  getEntry: (name) => {
    const spec = load().providers[name];
    return spec && typeof spec === "object" ? spec : null;
  },
  // originalName: the entry being edited (null for a new one).
  // id: where a new entry came from ("claude/relay", or "manual").
  saveEntry: ({ originalName = null, name, spec, id = "manual" }) => {
    const data = load();
    const providers = data.providers;
    if (originalName && !(originalName in providers)) throw new Error(`"${originalName}" is no longer in ${file()}. Rescan and try again.`);
    if (name !== originalName && name in providers) throw new Error(`A provider named "${name}" already exists in Pi.`);
    const next = {};
    let placed = false;
    Object.entries(providers).forEach(([key, value]) => {
      if (key === originalName) {
        next[name] = spec;
        placed = true;
      } else next[key] = value;
    });
    if (!placed) next[name] = spec;
    data.providers = next;
    const saved = writeData(data);
    const state = loadState();
    const managed = state.targets.pi.managed;
    if (originalName && managed[originalName]) {
      const meta = managed[originalName];
      delete managed[originalName];
      managed[name] = { ...meta, at: now() };
    } else if (!originalName) managed[name] = { id, at: now() };
    saveState(state);
    return { file: file(), backup: saved, name };
  },
  deleteEntry: (name) => {
    const data = load();
    if (!(name in data.providers)) throw new Error(`"${name}" is not in ${file()}.`);
    delete data.providers[name];
    const saved = writeData(data);
    forgetManaged("pi", [name]);
    return { file: file(), backup: saved, removed: [name] };
  },
  apply: (items) => {
    const data = load();
    const written = [];
    items.forEach((item) => {
      if (item.action === "skip") return;
      data.providers[item.name] = item.entry;
      written.push({ name: item.name, id: item.id });
    });
    const saved = writeData(data);
    rememberManaged("pi", written);
    return { file: file(), backup: saved, written: written.map((w) => w.name) };
  },
  remove: (names) => {
    const data = load();
    const removed = names.filter((name) => name in data.providers);
    removed.forEach((name) => delete data.providers[name]);
    const saved = removed.length ? writeData(data) : null;
    forgetManaged("pi", names);
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
      present = new Set(Object.keys(load().providers));
    } catch {
      // A restored file that fails to parse is still the user's file.
    }
    restoreManaged("pi", latest, present);
    return { file: path, restoredFrom: latest, remaining: backups.length - 1 };
  },
};
