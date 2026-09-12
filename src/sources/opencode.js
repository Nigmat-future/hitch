// OpenCode: ~/.config/opencode/opencode.json(c) declares providers under
// "provider" with an npm adapter and options.baseURL; keys are either
// {env:VAR}, {file:path}, a literal, or stored by /connect in
// ~/.local/share/opencode/auth.json as { "<id>": { "type": "api", "key": … } }.
import os from "node:os";
import path from "node:path";
import { parseJsonc } from "../parsers/json.js";
import { readText } from "../fsx.js";
import { paths } from "../paths.js";
import { isSecretKeyName } from "../redact.js";
import { keyFromEnv, keyNone, keyStored, makeProvider } from "../model.js";

const NPM_API = {
  "@ai-sdk/openai-compatible": "openai-completions",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google-generative-ai",
};

const ID_API = { anthropic: "anthropic-messages", openai: "openai-responses", google: "google-generative-ai" };

const expandHome = (file) => (file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file);

const readAuth = () => {
  const text = readText(paths().opencode.auth);
  if (text === null) return {};
  try {
    const parsed = parseJsonc(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const configFile = () => {
  const { config, configJsonc } = paths().opencode;
  if (readText(config) !== null) return config;
  if (readText(configJsonc) !== null) return configJsonc;
  return null;
};

export default {
  id: "opencode",
  label: "OpenCode",
  files: () => [
    { path: paths().opencode.config, role: "config (providers, models)" },
    { path: paths().opencode.auth, role: "keys added with /connect" },
  ],
  read: () => {
    const file = configFile();
    const problems = [];
    let config = {};
    if (file) {
      try {
        config = parseJsonc(readText(file)) ?? {};
      } catch (error) {
        problems.push(`${file}: ${error.message}`);
        config = {};
      }
    }
    const auth = readAuth();
    const table = config.provider && typeof config.provider === "object" ? config.provider : {};
    const providers = [];
    Object.entries(table).forEach(([id, spec]) => {
      if (!spec || typeof spec !== "object") return;
      const options = spec.options && typeof spec.options === "object" ? spec.options : {};
      const baseUrl = String(options.baseURL ?? options.baseUrl ?? "").trim();
      if (!baseUrl) return;
      const api = NPM_API[spec.npm] ?? ID_API[id] ?? "openai-completions";
      const headers = {};
      Object.entries(options.headers ?? {}).forEach(([k, v]) => {
        if (!isSecretKeyName(k)) headers[k] = String(v);
      });
      const notes = [];
      let key = keyNone();
      let secretRef;
      const raw = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
      const envMatch = /^\{env:([^}]+)\}$/.exec(raw);
      const fileMatch = /^\{file:([^}]+)\}$/.exec(raw);
      if (envMatch) key = keyFromEnv(envMatch[1].trim());
      else if (fileMatch) {
        const target = expandHome(fileMatch[1].trim());
        key = keyStored(target);
        secretRef = { kind: "file", file: target };
      } else if (raw) {
        key = keyStored(file, { field: `provider.${id}.options.apiKey` });
        secretRef = { kind: "json", file, path: ["provider", id, "options", "apiKey"] };
      } else if (auth[id] && typeof auth[id] === "object") {
        if (auth[id].type === "api" && auth[id].key) {
          key = keyStored(paths().opencode.auth, { field: id });
          secretRef = { kind: "json", file: paths().opencode.auth, path: [id, "key"] };
        } else notes.push(`OpenCode uses ${auth[id].type ?? "oauth"} login for this provider; not transferable`);
      }
      const models = Object.entries(spec.models ?? {}).map(([modelId, m]) => ({ id: modelId, ...(m && typeof m === "object" ? m : {}) }));
      providers.push(makeProvider({
        source: "opencode",
        name: id,
        file,
        baseUrl,
        api,
        key,
        models,
        headers,
        notes,
        extra: { displayName: spec.name, secretRef },
      }));
    });
    return { providers, problems };
  },
  readSecret: (provider) => {
    const ref = provider.secretRef;
    if (!ref) return provider.key.kind === "env" ? process.env[provider.key.env] : undefined;
    if (ref.kind === "file") return (readText(ref.file) ?? "").trim() || undefined;
    const parsed = parseJsonc(readText(ref.file) ?? "{}");
    const value = ref.path.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), parsed);
    return typeof value === "string" && value ? value : undefined;
  },
};
