// Claude Code keeps third-party endpoints in ~/.claude/settings.json under
// "env" (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY, model
// overrides) or resolves the key through an "apiKeyHelper" command.
import { parseJsonc } from "../parsers/json.js";
import { readText } from "../fsx.js";
import { paths } from "../paths.js";
import { isSecretKeyName } from "../redact.js";
import { keyFromCommand, keyNone, keyStored, makeProvider, slug } from "../model.js";

const MODEL_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

const OFFICIAL = /^https?:\/\/api\.anthropic\.com\/?$/i;

// "https://api.deepseek.com/v1" -> "deepseek", "http://10.0.0.5:8000" -> "10-0-0-5".
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "edu", "gov", "ne", "or"]);
export const nameFromUrl = (url, fallback = "provider") => {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (/^[\d.:]+$/.test(host) || !host.includes(".")) return slug(host) || fallback;
    const parts = host.split(".");
    parts.pop();
    if (parts.length > 1 && SECOND_LEVEL.has(parts[parts.length - 1])) parts.pop();
    return slug(parts[parts.length - 1]) || fallback;
  } catch {
    return fallback;
  }
};

const parseCustomHeaders = (raw) => {
  const headers = {};
  String(raw ?? "").split(/\r?\n/).forEach((line) => {
    const match = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(line);
    if (match && !isSecretKeyName(match[1])) headers[match[1]] = match[2].trim();
  });
  return headers;
};

// Shared with the CC Switch reader, which stores the same settings fragment.
export const providersFromClaudeSettings = (settings, { source = "claude", file, name, notes = [] } = {}) => {
  const env = settings?.env && typeof settings.env === "object" ? settings.env : {};
  const baseUrl = String(env.ANTHROPIC_BASE_URL ?? "").trim();
  const helper = typeof settings?.apiKeyHelper === "string" ? settings.apiKeyHelper.trim() : "";
  const tokenField = env.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null;
  if (!baseUrl && !tokenField && !helper) return [];
  const url = baseUrl || "https://api.anthropic.com";
  const providerNotes = [...notes];
  if (OFFICIAL.test(url)) providerNotes.push("official Anthropic endpoint; Pi and OMP have a built-in anthropic provider for this");
  let key = keyNone();
  if (helper) key = keyFromCommand(helper);
  else if (tokenField) key = keyStored(file, { field: `env.${tokenField}` });
  const models = [...new Set(MODEL_VARS.map((v) => env[v]).filter((v) => typeof v === "string" && v.trim()))]
    .map((id) => ({ id }));
  const extra = tokenField ? { secretRef: { file, path: ["env", tokenField] } } : {};
  return [makeProvider({
    source,
    name: name && slug(name) ? name : nameFromUrl(url, "anthropic"),
    file,
    baseUrl: url,
    api: "anthropic-messages",
    key,
    models,
    headers: parseCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
    notes: providerNotes,
    extra,
  })];
};

const readSettings = (file) => {
  const text = readText(file);
  return text === null ? null : parseJsonc(text);
};

export default {
  id: "claude",
  label: "Claude Code",
  files: () => [{ path: paths().claude.settings, role: "settings (endpoint, model names, token)" }],
  read: () => {
    const file = paths().claude.settings;
    const problems = [];
    let settings = null;
    try {
      settings = readSettings(file);
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
    }
    if (!settings) return { providers: [], problems };
    return { providers: providersFromClaudeSettings(settings, { file }), problems };
  },
  readSecret: (provider) => {
    const ref = provider.secretRef;
    if (!ref) return undefined;
    const settings = readSettings(ref.file);
    const value = ref.path.reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), settings);
    return typeof value === "string" && value ? value : undefined;
  },
};
