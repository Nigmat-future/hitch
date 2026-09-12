// Codex CLI declares providers in ~/.codex/config.toml as
// [model_providers.<id>] with base_url, env_key and wire_api. A key is
// either in the environment variable env_key names, or, for providers that
// reuse Codex's own login (requires_openai_auth, or no env_key at all, the
// shape CC Switch writes), the OPENAI_API_KEY field of ~/.codex/auth.json.
import { parseJsonc } from "../parsers/json.js";
import { parseToml } from "../parsers/toml.js";
import { readText } from "../fsx.js";
import { paths } from "../paths.js";
import { isSecretKeyName } from "../redact.js";
import { keyFromEnv, keyNone, keyStored, makeProvider, slug } from "../model.js";
import { nameFromUrl } from "./claude.js";

const apiFor = (wire) => (String(wire ?? "").toLowerCase() === "responses" ? "openai-responses" : "openai-completions");

const modelsFor = (config, providerId) => {
  const ids = new Set();
  if (config.model && (config.model_provider ?? "openai") === providerId) ids.add(String(config.model));
  const profiles = config.profiles && typeof config.profiles === "object" ? config.profiles : {};
  Object.values(profiles).forEach((profile) => {
    if (profile && typeof profile === "object" && profile.model && (profile.model_provider ?? config.model_provider ?? "openai") === providerId) {
      ids.add(String(profile.model));
    }
  });
  return [...ids].map((id) => ({ id }));
};

// authKey describes whether an OPENAI_API_KEY value is stored alongside this
// config (auth.json for Codex, the profile row for CC Switch):
// { where, secretRef } or null.
export const providersFromCodexConfig = (config, { source = "codex", file, authKey = null, nameOverride = null, notes = [] } = {}) => {
  const table = config?.model_providers && typeof config.model_providers === "object" ? config.model_providers : {};
  const out = [];
  Object.entries(table).forEach(([id, spec]) => {
    if (!spec || typeof spec !== "object") return;
    const baseUrl = String(spec.base_url ?? "").trim();
    if (!baseUrl) return;
    const headers = {};
    Object.entries(spec.http_headers ?? {}).forEach(([k, v]) => {
      if (!isSecretKeyName(k)) headers[k] = String(v);
    });
    Object.entries(spec.env_http_headers ?? {}).forEach(([k, v]) => {
      headers[k] = `$${v}`;
    });
    const providerNotes = [...notes];
    let key = keyNone();
    let secretRef;
    const envKey = spec.env_key ? String(spec.env_key) : null;
    const usesOpenAiKey = !envKey || envKey === "OPENAI_API_KEY" || spec.requires_openai_auth === true;
    if (envKey && !usesOpenAiKey) key = keyFromEnv(envKey);
    else if (process.env.OPENAI_API_KEY) key = keyFromEnv("OPENAI_API_KEY");
    else if (authKey) {
      key = keyStored(authKey.where, { field: "OPENAI_API_KEY" });
      secretRef = authKey.secretRef;
    } else providerNotes.push("key would come from Codex's OPENAI_API_KEY, which is not set here");
    const name = nameOverride && slug(nameOverride) ? nameOverride : slug(id) ? id : nameFromUrl(baseUrl, "codex");
    out.push(makeProvider({
      source,
      name,
      file,
      baseUrl,
      api: apiFor(spec.wire_api),
      key,
      models: modelsFor(config, id),
      headers,
      notes: providerNotes,
      extra: { displayName: spec.name ? String(spec.name) : undefined, secretRef },
    }));
  });
  return out;
};

const readAuthKey = () => {
  const file = paths().codex.auth;
  const text = readText(file);
  if (text === null) return null;
  try {
    const parsed = parseJsonc(text);
    if (typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY) {
      return { where: file, secretRef: { file, path: ["OPENAI_API_KEY"] } };
    }
  } catch {
    // auth.json unreadable: behave as if no key is stored.
  }
  return null;
};

export default {
  id: "codex",
  label: "Codex CLI",
  files: () => [
    { path: paths().codex.config, role: "config (providers, models)" },
    { path: paths().codex.auth, role: "OPENAI_API_KEY field only" },
  ],
  read: () => {
    const file = paths().codex.config;
    const text = readText(file);
    if (text === null) return { providers: [], problems: [] };
    try {
      return { providers: providersFromCodexConfig(parseToml(text), { file, authKey: readAuthKey() }), problems: [] };
    } catch (error) {
      return { providers: [], problems: [`${file}: ${error.message}`] };
    }
  },
  readSecret: (provider) => {
    if (provider.key.kind === "env") return process.env[provider.key.env];
    const ref = provider.secretRef;
    if (!ref) return undefined;
    const parsed = parseJsonc(readText(ref.file) ?? "{}");
    const value = ref.path.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), parsed);
    return typeof value === "string" && value ? value : undefined;
  },
};
