// ~/.hitch/state.json remembers which provider names hitch wrote into each
// target so `remove`, `scan` and the panel can tell them apart from
// hand-written ones. It holds names, source ids and timestamps only, never
// endpoints or keys. Each backup gets a snapshot of that list so `undo`
// restores it together with the file.
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";
import { exists, writeAtomic } from "./fsx.js";

const TARGETS = ["pi", "omp"];
const SNAPSHOTS_KEPT = 10;

const empty = () => ({ version: 1, targets: { pi: { managed: {}, snapshots: {} }, omp: { managed: {}, snapshots: {} } } });

export const loadState = () => {
  const file = paths().hitch.state;
  if (!exists(file)) return empty();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const state = empty();
    TARGETS.forEach((target) => {
      const { managed, snapshots } = parsed?.targets?.[target] ?? {};
      if (managed && typeof managed === "object") state.targets[target].managed = managed;
      if (snapshots && typeof snapshots === "object") state.targets[target].snapshots = snapshots;
    });
    return state;
  } catch {
    return empty();
  }
};

export const saveState = (state) => {
  writeAtomic(paths().hitch.state, `${JSON.stringify(state, null, 2)}\n`);
};

export const managedNames = (target) => new Set(Object.keys(loadState().targets[target]?.managed ?? {}));

export const rememberManaged = (target, entries) => {
  const state = loadState();
  entries.forEach(({ name, id }) => {
    state.targets[target].managed[name] = { id, at: new Date().toISOString() };
  });
  saveState(state);
};

export const forgetManaged = (target, names) => {
  const state = loadState();
  names.forEach((name) => delete state.targets[target].managed[name]);
  saveState(state);
};

// Called right after a backup is taken and before the write changes state.
export const snapshotManaged = (target, backupPath) => {
  if (!backupPath) return;
  const state = loadState();
  const t = state.targets[target];
  t.snapshots[path.basename(backupPath)] = structuredClone(t.managed);
  const keys = Object.keys(t.snapshots).sort();
  keys.slice(0, Math.max(0, keys.length - SNAPSHOTS_KEPT)).forEach((key) => delete t.snapshots[key]);
  saveState(state);
};

// Called by undo after the backup has been copied back over the file.
export const restoreManaged = (target, backupPath, presentNames) => {
  const state = loadState();
  const t = state.targets[target];
  const key = path.basename(backupPath);
  if (t.snapshots[key]) {
    t.managed = t.snapshots[key];
    delete t.snapshots[key];
  }
  if (presentNames) {
    Object.keys(t.managed).forEach((name) => {
      if (!presentNames.has(name)) delete t.managed[name];
    });
  }
  saveState(state);
};
