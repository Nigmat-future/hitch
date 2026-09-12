// The provider record every source produces and every target consumes.
// A record never carries a secret value. It carries a *description* of where
// the secret lives (env var, helper command, or a file hitch can re-read on
// demand) so that scanning, printing and JSON output are safe by construction.

export const APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);

export const API_LABELS = {
  "openai-completions": "OpenAI chat completions",
  "openai-responses": "OpenAI responses",
  "anthropic-messages": "Anthropic messages",
  "google-generative-ai": "Google Generative AI",
};

export const SOURCE_LABELS = {
  claude: "Claude Code",
  codex: "Codex CLI",
  opencode: "OpenCode",
  factory: "Factory Droid",
  ccswitch: "CC Switch",
  pi: "Pi",
  omp: "Oh My Pi",
  env: "Environment",
};

export const TARGETS = {
  pi: { label: "Pi", format: "models.json" },
  omp: { label: "Oh My Pi", format: "models.yml" },
};

export const slug = (text) => String(text ?? "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 48) || "provider";

export const providerId = (source, name) => `${source}/${slug(name)}`;

// key descriptors
export const keyFromEnv = (env) => ({ kind: "env", env, present: process.env[env] !== undefined && process.env[env] !== "" });
export const keyFromCommand = (command) => ({ kind: "command", command });
export const keyStored = (where, extra = {}) => ({ kind: "stored", where, ...extra });
export const keyNone = () => ({ kind: "none" });

export const describeKey = (key) => {
  switch (key?.kind) {
    case "env": return key.present ? `$${key.env}` : `$${key.env} (not set in this shell)`;
    case "command": return `!${key.command}`;
    case "stored": return "stored in source file";
    default: return "none";
  }
};

export const normalizeModel = (input) => {
  if (!input) return null;
  const raw = typeof input === "string" ? { id: input } : input;
  const id = String(raw.id ?? raw.model ?? "").trim();
  if (!id) return null;
  const model = { id };
  if (raw.name && raw.name !== id) model.name = String(raw.name);
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  if (Array.isArray(raw.input) && raw.input.length) model.input = raw.input.map(String);
  const context = Number(raw.contextWindow ?? raw.context ?? raw.limit?.context);
  const output = Number(raw.maxTokens ?? raw.maxOutputTokens ?? raw.limit?.output);
  if (Number.isFinite(context) && context > 0) model.contextWindow = context;
  if (Number.isFinite(output) && output > 0) model.maxTokens = output;
  return model;
};

export const makeProvider = ({ source, name, file, baseUrl, api, key, models = [], headers = {}, notes = [], extra = {} }) => {
  const trimmedUrl = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const record = {
    id: providerId(source, name),
    source,
    sourceLabel: SOURCE_LABELS[source] ?? source,
    file,
    name: String(name),
    baseUrl: trimmedUrl,
    api: APIS.has(api) ? api : "openai-completions",
    key: key ?? keyNone(),
    models: models.map(normalizeModel).filter(Boolean),
    headers: { ...headers },
    notes: [...notes],
    ...extra,
  };
  if (!APIS.has(api) && api) record.notes.push(`unknown api "${api}" mapped to openai-completions`);
  return record;
};

// Same endpoint + API style means the same provider, whatever it is called.
export const endpointKey = (baseUrl, api) => `${String(baseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase()}|${api ?? "openai-completions"}`;

// Sorting: grouped by source in the order tools are usually set up, then by name.
const SOURCE_ORDER = ["claude", "codex", "opencode", "factory", "ccswitch", "pi", "omp", "env"];
export const sortProviders = (providers) => [...providers].sort((a, b) => {
  const order = SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
  return order !== 0 ? order : a.id.localeCompare(b.id);
});

// Two records that point at the same endpoint with the same key source are
// considered the same provider; the first one wins and the others are noted.
export const dedupe = (providers) => {
  const seen = new Map();
  const out = [];
  providers.forEach((provider) => {
    const signature = `${provider.baseUrl}|${provider.api}|${provider.key.kind}|${provider.key.env ?? provider.key.command ?? provider.key.where ?? ""}`;
    const previous = seen.get(signature);
    if (previous) {
      previous.alsoIn = [...(previous.alsoIn ?? []), provider.id];
      provider.models.forEach((model) => {
        if (!previous.models.some((m) => m.id === model.id)) previous.models.push(model);
      });
      return;
    }
    seen.set(signature, provider);
    out.push(provider);
  });
  return out;
};
