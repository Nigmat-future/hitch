// CC Switch (cc-switch) keeps every Claude Code / Codex provider profile in
// ~/.cc-switch/cc-switch.db, table "providers" (id, app_type, name,
// settings_config). settings_config is the same fragment the tool writes into
// ~/.claude/settings.json ({ env: {...} }) or, for Codex, { auth: {...},
// config: "<toml>" }. Read-only, through Node's built-in SQLite.
import os from "node:os";
import path from "node:path";
import { exists } from "../fsx.js";
import { parseToml } from "../parsers/toml.js";
import { providersFromClaudeSettings } from "./claude.js";
import { providersFromCodexConfig } from "./codex.js";

const dbPath = () => path.join(process.env.HITCH_HOME_OVERRIDE || os.homedir(), ".cc-switch", "cc-switch.db");

let sqlite = null;
const loadSqlite = async () => {
  if (sqlite !== null) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes("SQLite")) return;
    original.call(process, warning, ...rest);
  };
  try {
    sqlite = (await import("node:sqlite")).DatabaseSync;
  } catch {
    sqlite = false;
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
};

const withDb = async (fn) => {
  const file = dbPath();
  if (!exists(file)) return null;
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

const parseRow = (row) => {
  let config;
  try {
    config = JSON.parse(row.settings_config);
  } catch {
    return [];
  }
  const label = `${row.name}`;
  const file = dbPath();
  if (row.app_type === "claude") {
    return providersFromClaudeSettings(config, { source: "ccswitch", file, name: row.name, notes: [`CC Switch profile "${label}"`] })
      .map((p) => ({ ...p, secretRef: p.secretRef ? { row: { id: row.id, app: row.app_type }, path: p.secretRef.path } : undefined }));
  }
  if (row.app_type === "codex") {
    let toml;
    try {
      toml = parseToml(String(config.config ?? ""));
    } catch {
      return [];
    }
    const authKey = config.auth?.OPENAI_API_KEY
      ? { where: file, secretRef: { row: { id: row.id, app: row.app_type }, path: ["auth", "OPENAI_API_KEY"] } }
      : null;
    return providersFromCodexConfig(toml, {
      source: "ccswitch",
      file,
      authKey,
      nameOverride: row.name,
      notes: [`CC Switch profile "${label}"`],
    });
  }
  return [];
};

export default {
  id: "ccswitch",
  label: "CC Switch",
  files: () => [{ path: dbPath(), role: "provider profiles (SQLite, read-only)" }],
  read: async () => {
    try {
      const rows = await withDb((db) => db.prepare("SELECT id, app_type, name, settings_config FROM providers ORDER BY app_type, sort_index, name").all());
      if (!rows) return { providers: [], problems: [] };
      return { providers: rows.flatMap(parseRow), problems: [] };
    } catch (error) {
      return { providers: [], problems: [`${dbPath()}: ${error.message}`] };
    }
  },
  readSecret: async (provider) => {
    if (provider.key.kind === "env") return process.env[provider.key.env];
    const ref = provider.secretRef;
    if (!ref?.row) return undefined;
    const row = await withDb((db) => db.prepare("SELECT settings_config FROM providers WHERE id = ? AND app_type = ?").get(ref.row.id, ref.row.app));
    if (!row) return undefined;
    const config = JSON.parse(row.settings_config);
    const value = ref.path.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), config);
    return typeof value === "string" && value ? value : undefined;
  },
};
