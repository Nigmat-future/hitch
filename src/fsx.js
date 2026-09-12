import fs from "node:fs";
import path from "node:path";

export const exists = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

export const readText = (file) => {
  if (!exists(file)) return null;
  return fs.readFileSync(file, "utf8");
};

export const stamp = (date = new Date()) => {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`;
};

// Backup sits next to the original, e.g. models.yml.bak-hitch-20260912-203000-120,
// matching the .bak-* convention most tools already leave behind. Names sort
// by time and never collide, so rapid saves each keep their own undo point.
export const backup = (file) => {
  if (!exists(file)) return null;
  let target = `${file}.bak-hitch-${stamp()}`;
  while (fs.existsSync(target)) target = `${file}.bak-hitch-${stamp()}`;
  fs.copyFileSync(file, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows ignores POSIX modes; nothing to do.
  }
  return target;
};

// Write to a temp file in the same directory, then rename over the original
// so a crash mid-write never leaves a half-written config behind.
export const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.hitch-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
};

export const pruneBackups = (file, keep = 5) => {
  const dir = path.dirname(file);
  const base = `${path.basename(file)}.bak-hitch-`;
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((name) => name.startsWith(base)).sort();
  } catch {
    return [];
  }
  const stale = entries.slice(0, Math.max(0, entries.length - keep));
  stale.forEach((name) => fs.rmSync(path.join(dir, name), { force: true }));
  return entries.slice(-keep).map((name) => path.join(dir, name));
};

export const listBackups = (file) => {
  const dir = path.dirname(file);
  const base = `${path.basename(file)}.bak-hitch-`;
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(base)).sort().map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};
