import test from "node:test";
import assert from "node:assert/strict";
import { BEGIN, END, readManagedBlock, spliceBlock } from "../src/targets/omp.js";
import { parseYaml } from "../src/parsers/yaml.js";

const entry = { baseUrl: "https://p.example.com/v1", api: "openai-completions", apiKey: "$P_KEY", models: [{ id: "m1" }] };

test("omp: creates providers key and block in an empty file", () => {
  const text = spliceBlock(null, { proxy: entry });
  assert.equal(text.split("\n")[0], "providers:");
  assert.ok(text.includes(`  ${BEGIN}`));
  assert.ok(text.includes(`  ${END}`));
  assert.deepEqual(parseYaml(text).providers.proxy, entry);
  assert.deepEqual(readManagedBlock(text), { proxy: entry });
});

test("omp: inserts under an existing providers map and preserves other text", () => {
  const original = `# my file
providers:
  mine:
    baseUrl: https://mine.example.com
    api: anthropic-messages
    apiKey: "$MINE"
retry:
  fallbackChains: []
`;
  const text = spliceBlock(original, { proxy: entry });
  assert.ok(text.startsWith("# my file\nproviders:\n  # BEGIN hitch"));
  assert.ok(text.includes("  mine:\n    baseUrl: https://mine.example.com"));
  assert.ok(text.endsWith("retry:\n  fallbackChains: []\n"));
  const data = parseYaml(text);
  assert.deepEqual(Object.keys(data.providers), ["proxy", "mine"]);
  assert.equal(data.providers.mine.apiKey, "$MINE");
});

test("omp: replaces its own block and removes it cleanly", () => {
  const first = spliceBlock("providers:\n  mine:\n    baseUrl: https://x\n", { a: entry });
  const second = spliceBlock(first, { b: entry });
  assert.equal(second.split(BEGIN).length, 2, "exactly one block");
  assert.deepEqual(Object.keys(parseYaml(second).providers), ["b", "mine"]);
  const removed = spliceBlock(second, {});
  assert.ok(!removed.includes(BEGIN));
  assert.deepEqual(Object.keys(parseYaml(removed).providers), ["mine"]);
});

test("omp: providers left empty becomes an empty map", () => {
  const withBlock = spliceBlock(null, { a: entry });
  const empty = spliceBlock(withBlock, {});
  assert.equal(empty, "providers: {}\n");
  const again = spliceBlock(empty, { a: entry });
  assert.deepEqual(parseYaml(again).providers.a, entry);
});
