// Editing providers by hand: form translation, in-place OMP edits, Pi
// renames, and the panel routes end to end (against a throwaway home).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSpec, parseTokens, previewText, publicEntry } from "../src/editor.js";
import { keyFromEnv, keyStored, makeProvider } from "../src/model.js";
import { parseYaml } from "../src/parsers/yaml.js";

const sandbox = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hitch-edit-"));
  process.env.HITCH_HOME_OVERRIDE = home;
  process.env.HITCH_STATE_DIR = path.join(home, ".hitch");
  process.env.PI_MODELS_PATH = path.join(home, ".pi", "agent", "models.json");
  process.env.OMP_MODELS_PATH = path.join(home, ".omp", "agent", "models.yml");
  process.env.CODEX_HOME = path.join(home, ".codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
  fs.mkdirSync(path.dirname(process.env.OMP_MODELS_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(process.env.PI_MODELS_PATH), { recursive: true });
  return home;
};

const { ompTarget } = await import("../src/targets/omp.js");
const { piTarget } = await import("../src/targets/pi.js");

test("parseTokens understands k / m and rejects junk", () => {
  assert.equal(parseTokens("200k"), 200000);
  assert.equal(parseTokens("1m"), 1000000);
  assert.equal(parseTokens("32,000"), 32000);
  assert.equal(parseTokens(""), null);
  assert.ok(Number.isNaN(parseTokens("lots")));
  assert.ok(Number.isNaN(parseTokens("1.5")));
});

test("buildSpec: editing keeps fields the form does not know about", async () => {
  const existing = {
    baseUrl: "https://old.example.com/v1",
    api: "openai-completions",
    apiKey: "sk-literal-secret-123456",
    authHeader: true,
    compat: { maxTokensField: "max_completion_tokens" },
    headers: { Authorization: "Bearer abc", "X-Team": "dev" },
    models: [{ id: "m1", name: "M1", contextWindow: 1000, cost: { input: 1, output: 2 }, compat: { supportsReasoningEffort: true } }, { id: "gone" }],
  };
  const pub = publicEntry({ name: "p", spec: existing, managed: null });
  assert.deepEqual(pub.key, { kind: "literal", length: 24 });
  assert.ok(!JSON.stringify(pub).includes("sk-literal"), "public entry never carries the key");
  assert.ok(!JSON.stringify(pub).includes("Bearer abc"), "secret header hidden");
  assert.deepEqual(pub.extra, ["authHeader", "compat"]);
  assert.deepEqual(pub.models[0].extra, ["cost", "compat"]);

  const { spec, errors } = await buildSpec({
    target: "omp",
    existing,
    form: {
      name: "p",
      baseUrl: "https://new.example.com/v1/",
      api: "openai-completions",
      key: { mode: "keep" },
      headers: [{ name: "Authorization", keep: true }, { name: "X-Team", value: "ops" }],
      models: [
        { originalId: "m1", id: "m1-renamed", name: "", contextWindow: "200k", maxTokens: "32k", reasoning: true, image: true },
        { originalId: null, id: "fresh", name: "Fresh", contextWindow: "", maxTokens: "" },
      ],
      discovery: false,
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(spec.baseUrl, "https://new.example.com/v1");
  assert.equal(spec.apiKey, "sk-literal-secret-123456");
  assert.equal(spec.authHeader, true);
  assert.deepEqual(spec.compat, { maxTokensField: "max_completion_tokens" });
  assert.deepEqual(spec.headers, { Authorization: "Bearer abc", "X-Team": "ops" });
  assert.deepEqual(spec.models, [
    { id: "m1-renamed", contextWindow: 200000, cost: { input: 1, output: 2 }, compat: { supportsReasoningEffort: true }, maxTokens: 32000, reasoning: true, input: ["text", "image"] },
    { id: "fresh", name: "Fresh" },
  ]);
  const preview = previewText("omp", "p", spec);
  assert.ok(!preview.includes("sk-literal"), "preview hides literal key");
  assert.ok(!preview.includes("Bearer abc"), "preview hides secret header");
  assert.match(preview, /hidden, 24 characters/);
});

test("entries that only tune a built-in provider are flagged and not reshaped", async () => {
  const override = { modelOverrides: { "z-ai/glm": { compat: { x: 1 } } } };
  const pub = publicEntry({ name: "openrouter", spec: override, managed: null });
  assert.equal(pub.override, true);
  assert.deepEqual(pub.extra, ["modelOverrides"]);
  assert.equal(publicEntry({ name: "p", spec: { baseUrl: "https://p" }, managed: null }).override, false);
  const noModels = await buildSpec({ target: "omp", existing: { baseUrl: "https://p", api: "openai-completions", apiKey: "$P" }, form: { name: "p", baseUrl: "https://p", api: "openai-completions", key: { mode: "keep" }, models: [] } });
  assert.equal("models" in noModels.spec, false, "no empty models list added to an entry that had none");
  const fresh = await buildSpec({ target: "pi", form: { name: "n", baseUrl: "https://n", api: "openai-completions", key: { mode: "none" }, models: [] } });
  assert.deepEqual(fresh.spec.models, [], "new providers always get a models list");
});

test("buildSpec: key modes and validation messages", async () => {
  const base = { name: "ok", baseUrl: "https://x.example.com", api: "anthropic-messages", models: [{ id: "a" }] };
  const env = await buildSpec({ target: "pi", form: { ...base, key: { mode: "env", env: "$HITCH_TEST_UNSET_VAR" } } });
  assert.equal(env.spec.apiKey, "$HITCH_TEST_UNSET_VAR");
  assert.match(env.warnings.map((w) => w.message).join(), /not set/);
  const cmd = await buildSpec({ target: "pi", form: { ...base, key: { mode: "command", command: "!op read x" } } });
  assert.equal(cmd.spec.apiKey, "!op read x");
  const none = await buildSpec({ target: "pi", form: { ...base, key: { mode: "none" } } });
  assert.equal("apiKey" in none.spec, false);

  const found = makeProvider({ source: "claude", name: "relay", file: "/f", baseUrl: "https://r.example.com", api: "anthropic-messages", key: keyStored("/f") });
  const ref = await buildSpec({ target: "omp", form: { ...base, key: { mode: "source" } }, found });
  assert.equal(ref.spec.apiKey, "!hitch key claude/relay");
  const previewCopy = await buildSpec({ target: "omp", form: { ...base, key: { mode: "source-copy" } }, found });
  assert.match(previewText("omp", "ok", previewCopy.spec), /copied from its source/);
  const savedCopy = await buildSpec({ target: "omp", form: { ...base, key: { mode: "source-copy" } }, found, readFoundSecret: async () => "sk-real" });
  assert.equal(savedCopy.spec.apiKey, "sk-real");
  const envFound = makeProvider({ source: "codex", name: "p", file: "/f", baseUrl: "https://p.example.com", api: "openai-responses", key: keyFromEnv("P_KEY") });
  assert.equal((await buildSpec({ target: "pi", form: { ...base, key: { mode: "source" } }, found: envFound })).spec.apiKey, "$P_KEY");

  const bad = await buildSpec({ target: "pi", form: { name: "no spaces!", baseUrl: "ftp://x", api: "bedrock-converse-stream", key: { mode: "value", value: "" }, models: [{ id: "a" }, { id: "a" }, { id: "b", contextWindow: "big" }] } });
  const fields = bad.errors.map((e) => e.field);
  assert.deepEqual(fields.sort(), ["api", "baseUrl", "key", "models.1.id", "models.2.contextWindow", "name"].sort());
  const plainHttp = await buildSpec({ target: "pi", form: { ...base, baseUrl: "http://public.example.com", key: { mode: "none" } } });
  assert.match(plainHttp.warnings.map((w) => w.message).join(), /unencrypted/);
  const local = await buildSpec({ target: "pi", form: { ...base, baseUrl: "http://localhost:11434/v1", key: { mode: "none" } } });
  assert.ok(!local.warnings.some((w) => w.field === "baseUrl"));
});

const HANDWRITTEN = `# My providers, lovingly curated
providers:
  # the cheap one
  cheap:
    baseUrl: https://cheap.example.com/v1   # comment on url
    api: openai-completions
    apiKey: "$CHEAP"
    models:
      - id: c1
        cost: { input: 0.1, output: 0.2 }

  "fancy.one":
    baseUrl: https://fancy.example.com
    api: anthropic-messages
    models: []
retry:
  fallbackChains: []   # keep me
`;

test("omp: editing a hand-written provider rewrites only its own lines", () => {
  sandbox();
  fs.writeFileSync(process.env.OMP_MODELS_PATH, HANDWRITTEN);
  const spec = { ...ompTarget.getEntry("cheap"), baseUrl: "https://cheaper.example.com/v1" };
  const result = ompTarget.saveEntry({ originalName: "cheap", name: "cheap", spec });
  assert.ok(result.backup, "backup made");
  const text = fs.readFileSync(process.env.OMP_MODELS_PATH, "utf8");
  assert.ok(text.startsWith("# My providers, lovingly curated\nproviders:\n  # the cheap one\n  cheap:\n    baseUrl: https://cheaper.example.com/v1\n"));
  assert.ok(text.includes('\n\n  "fancy.one":\n'), "blank line and quoted neighbour untouched");
  assert.ok(text.endsWith("retry:\n  fallbackChains: []   # keep me\n"), "rest of file untouched");
  assert.ok(!text.includes("BEGIN hitch"), "hand-written stays hand-written");
  const data = parseYaml(text);
  assert.deepEqual(data.providers.cheap.models[0].cost, { input: 0.1, output: 0.2 });

  ompTarget.saveEntry({ originalName: "fancy.one", name: "fancy", spec: { ...ompTarget.getEntry("fancy.one"), models: [{ id: "f1" }] } });
  const renamed = parseYaml(fs.readFileSync(process.env.OMP_MODELS_PATH, "utf8"));
  assert.deepEqual(Object.keys(renamed.providers), ["cheap", "fancy"]);
  assert.deepEqual(renamed.providers.fancy.models, [{ id: "f1" }]);

  assert.throws(() => ompTarget.saveEntry({ originalName: "cheap", name: "fancy", spec }), /already exists/);

  ompTarget.saveEntry({ name: "added", spec: { baseUrl: "https://added.example.com", api: "openai-responses", apiKey: "$ADDED", models: [{ id: "a" }] } });
  let now = fs.readFileSync(process.env.OMP_MODELS_PATH, "utf8");
  assert.ok(now.includes("BEGIN hitch"), "new provider goes into the managed block");
  assert.deepEqual(ompTarget.listEntries().map((e) => [e.name, Boolean(e.managed)]), [["added", true], ["cheap", false], ["fancy", false]]);

  ompTarget.saveEntry({ originalName: "added", name: "added-2", spec: { ...ompTarget.getEntry("added"), api: "openai-completions" } });
  assert.equal(ompTarget.listEntries().find((e) => e.name === "added-2").managed.id, "manual");

  ompTarget.deleteEntry("cheap");
  now = fs.readFileSync(process.env.OMP_MODELS_PATH, "utf8");
  assert.ok(!now.includes("cheap:"), "hand-written provider removed");
  assert.ok(now.includes("# the cheap one"), "comment above a deleted entry belongs to the file and stays");
  assert.ok(now.endsWith("retry:\n  fallbackChains: []   # keep me\n"));
  ompTarget.deleteEntry("added-2");
  ompTarget.deleteEntry("fancy");
  const empty = parseYaml(fs.readFileSync(process.env.OMP_MODELS_PATH, "utf8"));
  assert.deepEqual(empty.providers, {});
  assert.deepEqual(empty.retry, { fallbackChains: [] });
});

test("omp: refuses to write when the result would not read back", () => {
  sandbox();
  fs.writeFileSync(process.env.OMP_MODELS_PATH, HANDWRITTEN);
  const before = fs.readFileSync(process.env.OMP_MODELS_PATH, "utf8");
  // A value the tiny emitter cannot represent faithfully (a function) must be rejected.
  const spec = { baseUrl: "https://x", api: "openai-completions", models: [{ id: "m", weird: undefined, nested: [[1, 2]] }] };
  assert.throws(() => ompTarget.saveEntry({ originalName: "cheap", name: "cheap", spec }), /stopped before writing/);
  assert.equal(fs.readFileSync(process.env.OMP_MODELS_PATH, "utf8"), before, "file unchanged");
});

test("pi: rename keeps position, delete works on any provider", () => {
  sandbox();
  fs.writeFileSync(process.env.PI_MODELS_PATH, JSON.stringify({ modelOverrides: { x: 1 }, providers: { a: { baseUrl: "https://a", api: "openai-completions" }, b: { baseUrl: "https://b", api: "openai-completions" } } }));
  piTarget.saveEntry({ originalName: "a", name: "alpha", spec: { baseUrl: "https://a2", api: "openai-completions", models: [] } });
  const data = JSON.parse(fs.readFileSync(process.env.PI_MODELS_PATH, "utf8"));
  assert.deepEqual(Object.keys(data.providers), ["alpha", "b"]);
  assert.deepEqual(data.modelOverrides, { x: 1 });
  piTarget.deleteEntry("b");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(process.env.PI_MODELS_PATH, "utf8")).providers), ["alpha"]);
  assert.throws(() => piTarget.deleteEntry("b"), /not in/);
});

test("undo restores which providers hitch added, not just the file", () => {
  sandbox();
  fs.writeFileSync(process.env.OMP_MODELS_PATH, HANDWRITTEN);
  ompTarget.saveEntry({ name: "relay", spec: { baseUrl: "https://r.example.com", api: "anthropic-messages", models: [{ id: "a" }] }, id: "claude/relay" });
  ompTarget.saveEntry({ originalName: "cheap", name: "cheap", spec: { ...ompTarget.getEntry("cheap"), api: "openai-responses" } });
  ompTarget.deleteEntry("relay");
  assert.equal(ompTarget.listEntries().some((e) => e.name === "relay"), false);
  ompTarget.undo();
  assert.deepEqual(ompTarget.listEntries().find((e) => e.name === "relay").managed.id, "claude/relay");
  ompTarget.undo();
  assert.equal(ompTarget.getEntry("cheap").api, "openai-completions");
  assert.equal(ompTarget.listEntries().find((e) => e.name === "relay").managed.id, "claude/relay");
  ompTarget.undo();
  assert.equal(ompTarget.getEntry("relay"), null);
  assert.equal(fs.readFileSync(process.env.OMP_MODELS_PATH, "utf8"), HANDWRITTEN, "three undos return the original file");

  fs.writeFileSync(process.env.PI_MODELS_PATH, JSON.stringify({ providers: {} }));
  piTarget.saveEntry({ name: "p", spec: { baseUrl: "https://p", api: "openai-completions", models: [] }, id: "codex/p" });
  piTarget.deleteEntry("p");
  piTarget.undo();
  assert.equal(piTarget.listEntries().find((e) => e.name === "p").managed.id, "codex/p");
});

test("panel routes: preview, save, edit, delete, undo, and no key ever returned", async () => {
  const home = sandbox();
  fs.writeFileSync(process.env.OMP_MODELS_PATH, HANDWRITTEN);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.relay.com", ANTHROPIC_AUTH_TOKEN: "sk-ant-route-secret-0000000" } }));
  const { createServer } = await import("../src/ui/server.js");
  const ctx = { token: "t0k", origin: null };
  const server = createServer(ctx);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body) => {
    const res = await fetch(`${ctx.origin}${route}`, { method: body ? "POST" : "GET", headers: { "x-hitch-token": "t0k", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    assert.ok(!text.includes("sk-ant-route-secret"), `${route} leaked a key`);
    assert.ok(!text.includes("sk-pasted-secret"), `${route} echoed a pasted key`);
    return { status: res.status, data: JSON.parse(text) };
  };
  try {
    const state = await call("/api/state");
    const omp = state.data.targets.find((t) => t.id === "omp");
    assert.deepEqual(omp.entries.map((e) => e.name), ["cheap", "fancy.one"]);
    assert.ok(state.data.providers.some((p) => p.id === "claude/relay"));

    const form = { name: "relay", baseUrl: "https://api.relay.com", api: "anthropic-messages", key: { mode: "source-copy" }, models: [{ id: "claude-fable-5-1" }], headers: [] };
    const preview = await call("/api/preview", { target: "omp", sourceId: "claude/relay", form });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.data.errors, []);
    assert.match(preview.data.text, /copied from its source/);

    const invalid = await call("/api/save", { target: "omp", form: { ...form, name: "cheap", baseUrl: "nope" } });
    assert.equal(invalid.status, 422);
    assert.deepEqual(invalid.data.errors.map((e) => e.field).sort(), ["baseUrl", "key", "name"]);

    const saved = await call("/api/save", { target: "omp", sourceId: "claude/relay", form });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(ompTarget.getEntry("relay").apiKey, "sk-ant-route-secret-0000000", "copied at save time");

    const pasted = await call("/api/save", { target: "omp", originalName: "cheap", form: { name: "cheap", baseUrl: "https://cheap.example.com/v1", api: "openai-completions", key: { mode: "value", value: "sk-pasted-secret-999" }, models: [{ originalId: "c1", id: "c1" }], headers: [] } });
    assert.equal(pasted.status, 200, JSON.stringify(pasted.data));
    assert.equal(ompTarget.getEntry("cheap").apiKey, "sk-pasted-secret-999");
    assert.deepEqual(ompTarget.getEntry("cheap").models[0].cost, { input: 0.1, output: 0.2 });
    const after = await call("/api/state");
    assert.deepEqual(after.data.targets.find((t) => t.id === "omp").entries.find((e) => e.name === "cheap").key, { kind: "literal", length: 20 });

    const del = await call("/api/delete", { target: "omp", name: "fancy.one" });
    assert.equal(del.status, 200);
    assert.equal(ompTarget.getEntry("fancy.one"), null);
    const undone = await call("/api/undo", { target: "omp" });
    assert.equal(undone.status, 200);
    assert.ok(ompTarget.getEntry("fancy.one"), "undo restores the deleted provider");

    const stale = await call("/api/save", { target: "omp", originalName: "ghost", form });
    assert.equal(stale.status, 409);
    const noToken = await fetch(`${ctx.origin}/api/state`);
    assert.equal(noToken.status, 401);
  } finally {
    server.close();
  }
});
