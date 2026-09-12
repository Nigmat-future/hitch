import claude from "./claude.js";
import codex from "./codex.js";
import opencode from "./opencode.js";
import factory from "./factory.js";
import ccswitch from "./ccswitch.js";
import env from "./env.js";
import { ompSource, piSource } from "./pi-family.js";
import { dedupe, sortProviders } from "../model.js";

export const SOURCES = [claude, codex, opencode, factory, ccswitch, piSource, ompSource, env];

const byId = new Map(SOURCES.map((source) => [source.id, source]));

export const sourceFor = (provider) => byId.get(provider.source);

// Runs every reader. A broken file in one tool never hides the others.
export const scan = async ({ includeManaged = false } = {}) => {
  const providers = [];
  const problems = [];
  const stats = [];
  for (const source of SOURCES) {
    try {
      const result = await source.read();
      const found = result.providers.filter((p) => includeManaged || !p.managedByHitch);
      providers.push(...found);
      problems.push(...result.problems.map((text) => `${source.label}: ${text}`));
      stats.push({ id: source.id, label: source.label, count: found.length, files: source.files() });
    } catch (error) {
      problems.push(`${source.label}: ${error.message}`);
      stats.push({ id: source.id, label: source.label, count: 0, files: source.files() });
    }
  }
  return { providers: sortProviders(dedupe(providers)), problems, stats };
};

// The only path that ever touches a secret value. Called at write time when
// the user chose --keys copy, by `hitch key`, and by --discover.
export const readSecret = async (provider) => {
  const source = sourceFor(provider);
  if (!source) return undefined;
  const value = await source.readSecret(provider);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
