// Factory Droid keeps bring-your-own-key models in ~/.factory/settings.json
// (customModels, camelCase) or the older ~/.factory/config.json
// (custom_models, snake_case). Models sharing an endpoint and key become one
// provider.
import { parseJsonc } from "../parsers/json.js";
import { readText } from "../fsx.js";
import { paths } from "../paths.js";
import { isSecretKeyName } from "../redact.js";
import { keyFromEnv, keyNone, keyStored, makeProvider } from "../model.js";
import { nameFromUrl } from "./claude.js";

const PROVIDER_API = {
  anthropic: "anthropic-messages",
  openai: "openai-responses",
  "generic-chat-completion-api": "openai-completions",
  azure: "openai-completions",
};

const readModels = (file) => {
  const text = readText(file);
  if (text === null) return { list: [], legacy: false };
  const parsed = parseJsonc(text);
  if (Array.isArray(parsed?.customModels)) return { list: parsed.customModels, legacy: false, root: "customModels" };
  if (Array.isArray(parsed?.custom_models)) return { list: parsed.custom_models, legacy: true, root: "custom_models" };
  return { list: [], legacy: false };
};

const field = (entry, camel, snake) => entry[camel] ?? entry[snake];

export default {
  id: "factory",
  label: "Factory Droid",
  files: () => [
    { path: paths().factory.settings, role: "settings (customModels)" },
    { path: paths().factory.config, role: "legacy config (custom_models)" },
  ],
  read: () => {
    const problems = [];
    const groups = new Map();
    [paths().factory.settings, paths().factory.config].forEach((file) => {
      let entries;
      try {
        entries = readModels(file);
      } catch (error) {
        problems.push(`${file}: ${error.message}`);
        return;
      }
      entries.list.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") return;
        const baseUrl = String(field(entry, "baseUrl", "base_url") ?? "").trim();
        const modelId = String(field(entry, "model", "model") ?? "").trim();
        if (!baseUrl || !modelId) return;
        const rawKey = String(field(entry, "apiKey", "api_key") ?? "").trim();
        const envMatch = /^\$\{([^}]+)\}$/.exec(rawKey);
        const providerKind = String(entry.provider ?? "generic-chat-completion-api");
        const signature = `${baseUrl}|${providerKind}|${envMatch ? `$${envMatch[1]}` : rawKey ? `stored:${file}:${index}` : "none"}`;
        let group = groups.get(signature);
        if (!group) {
          let key = keyNone();
          let secretRef;
          if (envMatch) key = keyFromEnv(envMatch[1]);
          else if (rawKey) {
            key = keyStored(file, { field: `${entries.root}[${index}]` });
            secretRef = { file, path: [entries.root, index, entries.legacy ? "api_key" : "apiKey"] };
          }
          const headers = {};
          Object.entries(field(entry, "extraHeaders", "extra_headers") ?? {}).forEach(([k, v]) => {
            if (!isSecretKeyName(k)) headers[k] = String(v);
          });
          group = { file, baseUrl, api: PROVIDER_API[providerKind] ?? "openai-completions", key, secretRef, headers, models: [] };
          groups.set(signature, group);
        }
        const model = { id: modelId };
        const display = field(entry, "displayName", "model_display_name");
        if (display) model.name = String(display);
        const maxOut = Number(field(entry, "maxOutputTokens", "max_output_tokens"));
        if (Number.isFinite(maxOut) && maxOut > 0) model.maxTokens = maxOut;
        if (field(entry, "noImageSupport", "no_image_support") === true) model.input = ["text"];
        group.models.push(model);
      });
    });
    const used = new Set();
    const providers = [...groups.values()].map((group) => {
      let name = nameFromUrl(group.baseUrl, "factory");
      let candidate = name;
      let n = 2;
      while (used.has(candidate)) candidate = `${name}-${n++}`;
      used.add(candidate);
      name = candidate;
      return makeProvider({
        source: "factory",
        name,
        file: group.file,
        baseUrl: group.baseUrl,
        api: group.api,
        key: group.key,
        models: group.models,
        headers: group.headers,
        extra: { secretRef: group.secretRef },
      });
    });
    return { providers, problems };
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
