// Turns selected provider records into a write plan for one target. The plan
// is free of secret values: a key is either a reference string ($VAR, !cmd,
// !hitch key <id>) or the marker { copy: true }, which the target resolves at
// the moment it writes and never keeps.
import { endpointKey, slug } from "../model.js";

export const KEY_MODES = {
  ref: "reference the key where it already lives (default)",
  copy: "copy the key value into the target file",
  none: "write the provider without a key",
};

export const HITCH_KEY_NOTE = "\"!hitch key …\" entries are read from their source file by hitch at request time; keep hitch on the PATH of the shell that starts Pi/OMP.";

// Returns { apiKey, warnings, viaHitch }.
export const resolveKey = (provider, mode) => {
  const { key } = provider;
  const warnings = [];
  if (key.kind === "env") {
    if (!key.present) warnings.push(`$${key.env} is not set in this shell; Pi/OMP need it in theirs`);
    return { apiKey: `$${key.env}`, warnings, viaHitch: false };
  }
  if (key.kind === "command") return { apiKey: `!${key.command}`, warnings, viaHitch: false };
  if (key.kind === "stored") {
    if (mode === "copy") return { apiKey: { copy: true }, warnings: ["key value will be copied into the target file"], viaHitch: false };
    if (mode === "none") return { apiKey: undefined, warnings: ["no key written; add one with /login or edit the file"], viaHitch: false };
    return { apiKey: `!hitch key ${provider.id}`, warnings, viaHitch: true };
  }
  return { apiKey: undefined, warnings: ["source has no transferable key; add one with /login"], viaHitch: false };
};

const entryFor = (provider, target) => {
  const entry = { baseUrl: provider.baseUrl, api: provider.api };
  if (Object.keys(provider.headers ?? {}).length) entry.headers = { ...provider.headers };
  entry.models = provider.models.map((m) => ({ ...m }));
  if (target === "omp" && entry.models.length === 0 && provider.api.startsWith("openai-")) {
    entry.discovery = { type: "proxy" };
  }
  return entry;
};

export const buildPlan = ({ target, providers, existingNames, managed, endpoints = new Map(), keyMode = "ref", rename = {} }) => {
  const taken = new Set(existingNames);
  const items = [];
  providers.forEach((provider) => {
    const warnings = [];
    let name = slug(rename[provider.id] ?? provider.name);
    let action = "add";
    const sameEndpoint = endpoints.get(endpointKey(provider.baseUrl, provider.api));
    if (sameEndpoint !== undefined && managed.get(sameEndpoint)?.id === provider.id) {
      name = sameEndpoint;
      action = "update";
    } else if (sameEndpoint !== undefined) {
      const entry = entryFor(provider, target);
      items.push({ id: provider.id, provider, name: sameEndpoint, action: "skip", entry, viaHitch: false, warnings: [`already in ${target} as "${sameEndpoint}"`] });
      return;
    } else if (managed.get(name)?.id === provider.id) {
      action = "update";
    } else if (taken.has(name)) {
      const alt = `${name}-${provider.source}`;
      warnings.push(`"${name}" already exists in ${target}; using "${alt}"`);
      name = alt;
      if (taken.has(name)) {
        action = managed.get(name)?.id === provider.id ? "update" : "skip";
        if (action === "skip") warnings.push(`"${name}" is taken too; rename with --rename ${provider.id}=<name>`);
      }
    }
    taken.add(name);
    const { apiKey, warnings: keyWarnings, viaHitch } = resolveKey(provider, keyMode);
    const entry = entryFor(provider, target);
    if (apiKey !== undefined) entry.apiKey = apiKey;
    if (entry.models.length === 0 && !entry.discovery) warnings.push("no model ids known; add --discover or edit models later");
    items.push({ id: provider.id, provider, name, action, entry, viaHitch, warnings: [...warnings, ...keyWarnings] });
  });
  return items;
};

// Replaces { copy: true } with the real value right before writing.
export const materialize = async (items, readSecret) => {
  const out = [];
  for (const item of items) {
    const entry = { ...item.entry };
    if (entry.apiKey && typeof entry.apiKey === "object" && entry.apiKey.copy) {
      const value = await readSecret(item.provider);
      if (!value) {
        delete entry.apiKey;
        item.warnings.push("could not read the key from its source; written without a key");
      } else entry.apiKey = value;
    }
    out.push({ ...item, entry });
  }
  return out;
};
