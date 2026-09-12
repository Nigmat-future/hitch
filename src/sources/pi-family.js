// Pi (~/.pi/agent/models.json) and Oh My Pi (~/.omp/agent/models.yml) share
// one provider schema, so one reader serves both. Providers hitch itself
// wrote into these files are recognised and skipped so they never round-trip.
import { parseJsonc } from "../parsers/json.js";
import { parseYaml } from "../parsers/yaml.js";
import { readText } from "../fsx.js";
import { paths } from "../paths.js";
import { isSecretKeyName } from "../redact.js";
import { keyFromCommand, keyFromEnv, keyNone, keyStored, makeProvider } from "../model.js";
import { managedNames } from "../state.js";

const HITCH_REF = /^!hitch\s+key\s+/;

const parseFile = (kind, file) => {
  const text = readText(file);
  if (text === null) return null;
  return kind === "pi" ? parseJsonc(text) : parseYaml(text);
};

export const providersFromPiFamily = (kind, data, file) => {
  const table = data?.providers && typeof data.providers === "object" ? data.providers : {};
  const managed = managedNames(kind);
  const providers = [];
  Object.entries(table).forEach(([name, spec]) => {
    if (!spec || typeof spec !== "object") return;
    const baseUrl = String(spec.baseUrl ?? spec.base_url ?? "").trim();
    if (!baseUrl) return;
    const notes = [];
    if (managed.has(name)) notes.push("written by hitch");
    const raw = typeof spec.apiKey === "string" ? spec.apiKey.trim() : "";
    let key = keyNone();
    let secretRef;
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) key = keyFromEnv(raw.slice(1));
    else if (raw.startsWith("!")) {
      key = keyFromCommand(raw.slice(1));
      if (HITCH_REF.test(raw)) notes.push(`resolves through hitch (${raw.replace(HITCH_REF, "")})`);
    } else if (raw) {
      key = keyStored(file, { field: `providers.${name}.apiKey` });
      secretRef = { file, kind, path: ["providers", name, "apiKey"] };
    }
    const headers = {};
    Object.entries(spec.headers ?? {}).forEach(([k, v]) => {
      if (!isSecretKeyName(k)) headers[k] = String(v);
    });
    providers.push(makeProvider({
      source: kind,
      name,
      file,
      baseUrl,
      api: spec.api,
      key,
      models: Array.isArray(spec.models) ? spec.models : [],
      headers,
      notes,
      extra: { secretRef, managedByHitch: managed.has(name) },
    }));
  });
  return providers;
};

const reader = (kind, label, role) => ({
  id: kind,
  label,
  files: () => [{ path: paths()[kind].models, role }],
  read: () => {
    const file = paths()[kind].models;
    try {
      const data = parseFile(kind, file);
      if (!data) return { providers: [], problems: [] };
      return { providers: providersFromPiFamily(kind, data, file), problems: [] };
    } catch (error) {
      return { providers: [], problems: [`${file}: ${error.message}`] };
    }
  },
  readSecret: (provider) => {
    if (provider.key.kind === "env") return process.env[provider.key.env];
    const ref = provider.secretRef;
    if (!ref) return undefined;
    const data = parseFile(ref.kind, ref.file);
    const value = ref.path.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), data);
    return typeof value === "string" && value ? value : undefined;
  },
});

export const piSource = reader("pi", "Pi", "custom providers (models.json)");
export const ompSource = reader("omp", "Oh My Pi", "custom providers (models.yml)");
