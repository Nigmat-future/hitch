// End-to-end through the real binary against a throwaway home directory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../src/parsers/yaml.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "hitch.js");

const SECRET_CLAUDE = "sk-ant-claude-secret-0123456789";
const SECRET_OPENCODE = "oc-secret-0123456789abcdef";
const SECRET_FACTORY = "fk-secret-0123456789abcdef";

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hitch-home-"));
  const write = (rel, text) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(".claude/settings.json", JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://api.relay.com", ANTHROPIC_AUTH_TOKEN: SECRET_CLAUDE, ANTHROPIC_MODEL: "claude-fable-5-1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5" },
  }));
  write(".codex/config.toml", `model = "gpt-5.5"\nmodel_provider = "proxy"\n\n[model_providers.proxy]\nname = "Proxy"\nbase_url = "https://proxy.example.com/v1"\nenv_key = "PROXY_KEY"\nwire_api = "responses"\n`);
  write(".config/opencode/opencode.json", JSON.stringify({
    provider: {
      local: { npm: "@ai-sdk/openai-compatible", name: "Local", options: { baseURL: "http://localhost:11434/v1", apiKey: "{env:OLLAMA_KEY}" }, models: { "qwen3:8b": { name: "Qwen3 8B", limit: { context: 32000, output: 8000 } } } },
      paid: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://paid.example.com" } },
    },
  }));
  write(".local/share/opencode/auth.json", JSON.stringify({ paid: { type: "api", key: SECRET_OPENCODE }, github: { type: "oauth" } }));
  write(".factory/settings.json", JSON.stringify({ customModels: [
    { model: "glm-5", displayName: "GLM 5", baseUrl: "https://open.glm.ai/v1", apiKey: SECRET_FACTORY, provider: "generic-chat-completion-api", maxOutputTokens: 16000 },
    { model: "glm-5-air", baseUrl: "https://open.glm.ai/v1", apiKey: SECRET_FACTORY, provider: "generic-chat-completion-api" },
  ] }));
  write(".omp/agent/models.yml", "providers:\n  handmade:\n    baseUrl: https://hand.example.com\n    api: openai-completions\n    apiKey: \"$HAND\"\n    models:\n      - id: h1\n");
  return home;
};

const run = (home, args, extraEnv = {}) => {
  const env = { ...process.env, HITCH_HOME_OVERRIDE: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), HITCH_STATE_DIR: path.join(home, ".hitch"), CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), PI_MODELS_PATH: path.join(home, ".pi", "agent", "models.json"), OMP_MODELS_PATH: path.join(home, ".omp", "agent", "models.yml"), ...extraEnv };
  ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "DASHSCOPE_API_KEY", "SILICONFLOW_API_KEY", "MINIMAX_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "PERPLEXITY_API_KEY", "PROXY_KEY", "OLLAMA_KEY"].forEach((k) => { if (!(k in extraEnv)) delete env[k]; });
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env, cwd: root });
};

test("scan finds providers from every source and never prints a secret", () => {
  const home = makeHome();
  const json = run(home, ["scan", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  const ids = data.providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ["claude/relay", "codex/proxy", "factory/glm", "omp/handmade", "opencode/local", "opencode/paid"]);
  const claude = data.providers.find((p) => p.id === "claude/relay");
  assert.equal(claude.key.kind, "stored");
  assert.deepEqual(claude.models.map((m) => m.id), ["claude-fable-5-1", "claude-haiku-4-5"]);
  assert.equal(data.providers.find((p) => p.id === "codex/proxy").key.env, "PROXY_KEY");
  assert.equal(data.providers.find((p) => p.id === "opencode/paid").api, "anthropic-messages");
  assert.equal(data.providers.find((p) => p.id === "factory/glm").models.length, 2);
  [SECRET_CLAUDE, SECRET_OPENCODE, SECRET_FACTORY].forEach((secret) => assert.ok(!json.stdout.includes(secret), "secret leaked in --json"));
  const human = run(home, []);
  assert.equal(human.status, 0, human.stderr);
  [SECRET_CLAUDE, SECRET_OPENCODE, SECRET_FACTORY].forEach((secret) => assert.ok(!human.stdout.includes(secret), "secret leaked in table"));
  assert.match(human.stdout, /Nothing left this machine/);
});

test("omp: write with references, remove, undo", () => {
  const home = makeHome();
  const ymlPath = path.join(home, ".omp", "agent", "models.yml");
  const dry = run(home, ["omp", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run/);
  assert.equal(fs.readFileSync(ymlPath, "utf8").includes("BEGIN hitch"), false);

  const write = run(home, ["omp", "claude/relay", "codex/proxy", "factory", "--yes"]);
  assert.equal(write.status, 0, write.stderr);
  const text = fs.readFileSync(ymlPath, "utf8");
  const data = parseYaml(text);
  assert.deepEqual(Object.keys(data.providers).sort(), ["glm", "handmade", "proxy", "relay"]);
  assert.equal(data.providers.relay.apiKey, "!hitch key claude/relay");
  assert.equal(data.providers.proxy.apiKey, "$PROXY_KEY");
  assert.equal(data.providers.proxy.api, "openai-responses");
  assert.equal(data.providers.glm.models.length, 2);
  assert.equal(data.providers.handmade.apiKey, "$HAND", "hand-written provider untouched");
  assert.ok(!text.includes(SECRET_CLAUDE) && !text.includes(SECRET_FACTORY), "no secret copied by default");
  assert.equal(fs.readdirSync(path.dirname(ymlPath)).filter((n) => n.includes(".bak-hitch-")).length, 1);

  // A second run updates in place instead of duplicating.
  const again = run(home, ["omp", "codex/proxy", "--yes"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /~ update/);
  assert.equal(fs.readFileSync(ymlPath, "utf8").split("BEGIN hitch").length, 2);

  // scan hides hitch-managed providers so they never round-trip.
  const rescan = JSON.parse(run(home, ["scan", "--json"]).stdout);
  assert.ok(!rescan.providers.some((p) => p.id === "omp/relay"));
  assert.ok(rescan.providers.some((p) => p.id === "omp/handmade"));

  const remove = run(home, ["remove", "omp", "relay", "--yes"]);
  assert.equal(remove.status, 0, remove.stderr);
  assert.deepEqual(Object.keys(parseYaml(fs.readFileSync(ymlPath, "utf8")).providers).sort(), ["glm", "handmade", "proxy"]);

  const refuse = run(home, ["remove", "omp", "handmade", "--yes"]);
  assert.notEqual(refuse.status, 0);
  assert.match(refuse.stderr, /not written by hitch/);

  const undo = run(home, ["undo", "omp"]);
  assert.equal(undo.status, 0, undo.stderr);
  assert.deepEqual(Object.keys(parseYaml(fs.readFileSync(ymlPath, "utf8")).providers).sort(), ["glm", "handmade", "proxy", "relay"]);
});

test("pi: creates models.json, copy mode writes the value, key command reads it back", () => {
  const home = makeHome();
  const jsonPath = path.join(home, ".pi", "agent", "models.json");
  const write = run(home, ["pi", "opencode/paid", "opencode/local", "--keys", "copy", "--yes"]);
  assert.equal(write.status, 0, write.stderr);
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(data.providers.paid.apiKey, SECRET_OPENCODE);
  assert.equal(data.providers.local.apiKey, "$OLLAMA_KEY");
  assert.equal(data.providers.local.models[0].contextWindow, 32000);
  assert.equal(data.providers.local.models[0].name, "Qwen3 8B");

  const key = run(home, ["key", "opencode/paid"]);
  assert.equal(key.status, 0, key.stderr);
  assert.equal(key.stdout, SECRET_OPENCODE);

  const none = run(home, ["pi", "claude/relay", "--keys", "none", "--yes"]);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(JSON.parse(fs.readFileSync(jsonPath, "utf8")).providers.relay.apiKey, undefined);

  const rename = run(home, ["pi", "factory/glm", "--rename", "factory/glm=zhipu", "--yes"]);
  assert.equal(rename.status, 0, rename.stderr);
  assert.equal(JSON.parse(fs.readFileSync(jsonPath, "utf8")).providers.zhipu.apiKey, "!hitch key factory/glm");
});

test("sources lists files and unknown ids fail clearly", () => {
  const home = makeHome();
  const sources = run(home, ["sources"]);
  assert.equal(sources.status, 0, sources.stderr);
  assert.match(sources.stdout, /Claude Code/);
  assert.match(sources.stdout, /found/);
  const bad = run(home, ["omp", "nope/none", "--yes"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no provider matches/);
});
