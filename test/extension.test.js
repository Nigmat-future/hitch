// The Pi extension, driven by a fake Pi API against a throwaway home directory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import hitch from "../extensions/hitch.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "fk-secret-0123456789abcdef";

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hitch-ext-"));
  const write = (rel, text) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(".codex/config.toml", `[model_providers.proxy]\nname = "Proxy"\nbase_url = "https://proxy.example.com/v1"\nenv_key = "PROXY_KEY"\nwire_api = "responses"\n`);
  write(".factory/settings.json", JSON.stringify({ customModels: [{ model: "glm-5", baseUrl: "https://open.glm.ai/v1", apiKey: SECRET, provider: "generic-chat-completion-api" }] }));
  return home;
};

const envFor = (home) => {
  const env = { ...process.env, HITCH_HOME_OVERRIDE: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), HITCH_STATE_DIR: path.join(home, ".hitch"), CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), PI_MODELS_PATH: path.join(home, ".pi", "agent", "models.json"), OMP_MODELS_PATH: path.join(home, ".omp", "agent", "models.yml") };
  ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PROXY_KEY"].forEach((k) => delete env[k]);
  return env;
};

const fakePi = (home) => {
  const commands = new Map();
  const events = new Map();
  return {
    commands,
    events,
    registerCommand: (name, spec) => commands.set(name, spec),
    on: (event, fn) => events.set(event, fn),
    exec: async (cmd, args, { timeout } = {}) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", env: envFor(home), cwd: root, timeout });
      return { stdout: r.stdout, stderr: r.stderr, code: r.status, killed: false };
    },
  };
};

const fakeCtx = ({ select, confirm = true } = {}) => {
  const notes = [];
  let refreshed = 0;
  return {
    notes,
    get refreshed() { return refreshed; },
    hasUI: true,
    ui: {
      notify: (message, level) => notes.push({ message, level }),
      select: async (_title, items) => (typeof select === "function" ? select(items) : select),
      confirm: async () => confirm,
    },
    modelRegistry: { refresh: async () => { refreshed += 1; } },
  };
};

test("registers /hitch, /hitch-undo, /hitch-ui and a shutdown hook", () => {
  const pi = fakePi(makeHome());
  hitch(pi);
  assert.deepEqual([...pi.commands.keys()].sort(), ["hitch", "hitch-ui", "hitch-undo"]);
  pi.commands.forEach((spec) => assert.equal(typeof spec.handler, "function"));
  assert.equal(typeof pi.events.get("session_shutdown"), "function");
});

test("/hitch adds the picked provider to Pi, refreshes models, and never shows a key", async () => {
  const home = makeHome();
  const pi = fakePi(home);
  hitch(pi);
  const ctx = fakeCtx({ select: (items) => items.find((i) => i.startsWith("factory/")) });
  await pi.commands.get("hitch").handler("", ctx);

  const models = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8"));
  const written = Object.values(models.providers);
  assert.equal(written.length, 1);
  assert.equal(written[0].baseUrl, "https://open.glm.ai/v1");
  assert.equal(ctx.refreshed, 1);
  assert.equal(ctx.notes.at(-1).level, "info", JSON.stringify(ctx.notes));
  assert.match(ctx.notes.at(-1).message, /Wrote 1 provider/);
  assert.ok(!JSON.stringify(ctx.notes).includes(SECRET));
});

test("/hitch with ids skips the picker; a declined confirm writes nothing", async () => {
  const home = makeHome();
  const pi = fakePi(home);
  hitch(pi);
  await pi.commands.get("hitch").handler("codex/proxy", fakeCtx({ select: () => assert.fail("picker shown"), confirm: false }));
  assert.equal(fs.existsSync(path.join(home, ".pi", "agent", "models.json")), false);

  const ctx = fakeCtx({ select: () => assert.fail("picker shown") });
  await pi.commands.get("hitch").handler("omp codex/proxy", ctx);
  assert.match(fs.readFileSync(path.join(home, ".omp", "agent", "models.yml"), "utf8"), /proxy\.example\.com/);
  assert.equal(ctx.refreshed, 0, "OMP writes do not touch Pi's registry");
});

test("/hitch-undo restores Pi's models file and errors surface as notifications", async () => {
  const home = makeHome();
  const pi = fakePi(home);
  hitch(pi);
  const empty = fakeCtx();
  await pi.commands.get("hitch-undo").handler("", empty);
  assert.equal(empty.notes.at(-1).level, "error");
  assert.match(empty.notes.at(-1).message, /^hitch: /);

  const file = path.join(home, ".pi", "agent", "models.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ providers: {} }));
  await pi.commands.get("hitch").handler("codex/proxy", fakeCtx());
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).providers).length);

  const ctx = fakeCtx();
  await pi.commands.get("hitch-undo").handler("", ctx);
  assert.equal(ctx.notes.at(-1).level, "info", JSON.stringify(ctx.notes));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).providers, {});
  assert.equal(ctx.refreshed, 1);
});

test("the extension only runs hitch's own binary and uses no network API", () => {
  const text = fs.readFileSync(path.join(root, "extensions", "hitch.js"), "utf8");
  assert.equal(/\bfetch\s*\(|from\s+"node:(http|https|net|dgram|tls|http2)"|WebSocket|XMLHttpRequest/.test(text), false);
  const spawns = [...text.matchAll(/(?:spawn|pi\.exec)\(([^,]+),\s*\[([^\]\s,]+)/g)];
  assert.ok(spawns.length >= 2);
  spawns.forEach(([, cmd, first]) => {
    assert.equal(cmd.trim(), "nodeBin()");
    assert.equal(first.trim(), "BIN");
  });
  assert.ok(!/readFileSync|writeFileSync/.test(text), "the extension never opens files itself");
});
