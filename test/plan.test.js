import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan, materialize, resolveKey } from "../src/targets/common.js";
import { keyFromCommand, keyFromEnv, keyNone, keyStored, makeProvider } from "../src/model.js";

const provider = (over = {}) => makeProvider({
  source: "codex", name: "proxy", file: "x", baseUrl: "https://p.example.com/v1/", api: "openai-responses", key: keyFromEnv("P_KEY"), models: [{ id: "m" }], ...over,
});

test("resolveKey: env, command, stored per mode, none", () => {
  process.env.P_KEY = "x";
  assert.equal(resolveKey(provider(), "ref").apiKey, "$P_KEY");
  delete process.env.P_KEY;
  assert.match(resolveKey(provider(), "ref").warnings[0], /not set/);
  assert.equal(resolveKey(provider({ key: keyFromCommand("helper --x") }), "copy").apiKey, "!helper --x");
  const stored = provider({ key: keyStored("/f") });
  assert.equal(resolveKey(stored, "ref").apiKey, "!hitch key codex/proxy");
  assert.deepEqual(resolveKey(stored, "copy").apiKey, { copy: true });
  assert.equal(resolveKey(stored, "none").apiKey, undefined);
  assert.equal(resolveKey(provider({ key: keyNone() }), "ref").apiKey, undefined);
});

test("buildPlan: names, conflicts, updates and omp discovery", () => {
  const p = provider();
  const items = buildPlan({ target: "omp", providers: [p], existingNames: new Set(["proxy"]), managed: new Map(), keyMode: "ref" });
  assert.equal(items[0].name, "proxy-codex");
  assert.equal(items[0].action, "add");
  assert.match(items[0].warnings[0], /already exists/);

  const update = buildPlan({ target: "omp", providers: [p], existingNames: new Set(["proxy"]), managed: new Map([["proxy", { id: p.id }]]), keyMode: "ref" });
  assert.equal(update[0].action, "update");
  assert.equal(update[0].name, "proxy");
  assert.equal(update[0].entry.baseUrl, "https://p.example.com/v1", "trailing slash trimmed");

  const noModels = buildPlan({ target: "omp", providers: [provider({ models: [] })], existingNames: new Set(), managed: new Map() });
  assert.deepEqual(noModels[0].entry.discovery, { type: "proxy" });
  const piNoModels = buildPlan({ target: "pi", providers: [provider({ models: [] })], existingNames: new Set(), managed: new Map() });
  assert.equal(piNoModels[0].entry.discovery, undefined);
  assert.match(piNoModels[0].warnings.join(" "), /no model ids/);

  const renamed = buildPlan({ target: "pi", providers: [p], existingNames: new Set(), managed: new Map(), rename: { [p.id]: "My Proxy!" } });
  assert.equal(renamed[0].name, "my-proxy");
});

test("buildPlan: an endpoint the target already has is skipped, or updated when hitch wrote it", () => {
  const p = provider();
  const endpoints = new Map([["https://p.example.com/v1|openai-responses", "hand-written"]]);
  const skipped = buildPlan({ target: "pi", providers: [p], existingNames: new Set(["hand-written"]), endpoints, managed: new Map() });
  assert.equal(skipped[0].action, "skip");
  assert.equal(skipped[0].name, "hand-written");
  assert.match(skipped[0].warnings[0], /already in pi as "hand-written"/);

  const ours = buildPlan({ target: "pi", providers: [p], existingNames: new Set(["renamed"]), endpoints: new Map([["https://p.example.com/v1|openai-responses", "renamed"]]), managed: new Map([["renamed", { id: p.id }]]) });
  assert.equal(ours[0].action, "update");
  assert.equal(ours[0].name, "renamed");
  assert.equal(ours[0].viaHitch, false);
});

test("materialize: copies the secret only at write time", async () => {
  const stored = provider({ key: keyStored("/f") });
  const items = buildPlan({ target: "pi", providers: [stored], existingNames: new Set(), managed: new Map(), keyMode: "copy" });
  assert.deepEqual(items[0].entry.apiKey, { copy: true });
  const ready = await materialize(items, async () => "sk-secret-value");
  assert.equal(ready[0].entry.apiKey, "sk-secret-value");
  assert.deepEqual(items[0].entry.apiKey, { copy: true }, "plan object untouched");
  const missing = await materialize(items, async () => undefined);
  assert.equal(missing[0].entry.apiKey, undefined);
});
