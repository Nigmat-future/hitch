import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonc } from "../src/parsers/json.js";
import { parseToml } from "../src/parsers/toml.js";
import { emitYaml, parseYaml } from "../src/parsers/yaml.js";

test("jsonc: comments and trailing commas", () => {
  const text = `{
    // comment
    "a": 1, /* block */
    "url": "http://x/y", // slashes inside strings survive
    "list": [1, 2,],
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, url: "http://x/y", list: [1, 2] });
});

test("toml: codex-style config", () => {
  const text = `
model = "gpt-5.5"
model_provider = "myproxy"

[model_providers.myproxy]
name = "My Proxy"
base_url = "https://proxy.example.com/v1"
env_key = "MYPROXY_KEY"
wire_api = "responses"
http_headers = { "X-Team" = "dev" }
env_http_headers = { "X-Trace" = "TRACE_ID" }
request_max_retries = 4

[model_providers."quoted.id"]
base_url = 'https://literal.example.com'

[profiles.fast]
model = "gpt-5.5-mini"
model_provider = "myproxy"

[[mcp_servers]]
name = "one"
args = ["a", "b",
  "c"]
`;
  const config = parseToml(text);
  assert.equal(config.model, "gpt-5.5");
  assert.equal(config.model_providers.myproxy.base_url, "https://proxy.example.com/v1");
  assert.equal(config.model_providers.myproxy.http_headers["X-Team"], "dev");
  assert.equal(config.model_providers.myproxy.env_http_headers["X-Trace"], "TRACE_ID");
  assert.equal(config.model_providers.myproxy.request_max_retries, 4);
  assert.equal(config.model_providers["quoted.id"].base_url, "https://literal.example.com");
  assert.equal(config.profiles.fast.model, "gpt-5.5-mini");
  assert.deepEqual(config.mcp_servers[0].args, ["a", "b", "c"]);
});

test("toml: rejects duplicate keys", () => {
  assert.throws(() => parseToml("a = 1\na = 2"), /duplicate/);
});

test("yaml: omp-style models.yml", () => {
  const text = `# Custom providers
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1   # trailing comment
    api: openai-completions
    apiKey: "$SPARK_KEY"
    authHeader: true
    headers:
      X-Team: 'dev ''ops'''
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
        input: [text, image]
        cost: { input: 0, output: 0.5 }
      - id: plain
  other: {}
notes: |
  line one
  line two
`;
  const data = parseYaml(text);
  assert.equal(data.providers.spark.baseUrl, "http://192.168.10.223:8000/v1");
  assert.equal(data.providers.spark.apiKey, "$SPARK_KEY");
  assert.equal(data.providers.spark.authHeader, true);
  assert.equal(data.providers.spark.headers["X-Team"], "dev 'ops'");
  assert.equal(data.providers.spark.models[0].contextWindow, 100000);
  assert.deepEqual(data.providers.spark.models[0].input, ["text", "image"]);
  assert.deepEqual(data.providers.spark.models[0].cost, { input: 0, output: 0.5 });
  assert.deepEqual(data.providers.spark.models[1], { id: "plain" });
  assert.deepEqual(data.providers.other, {});
  assert.equal(data.notes, "line one\nline two\n");
});

test("yaml: emit then parse round-trips provider entries", () => {
  const entry = {
    proxy: {
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-completions",
      apiKey: "!hitch key codex/proxy",
      headers: { "X-Team": "dev: ops" },
      models: [
        { id: "gpt-5.5", name: "GPT 5.5", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 },
        { id: "true" },
      ],
      discovery: { type: "proxy" },
      empty: [],
    },
  };
  const text = emitYaml(entry);
  assert.match(text, /apiKey: "!hitch key codex\/proxy"/);
  assert.match(text, /- id: "true"/);
  assert.deepEqual(parseYaml(text), entry);
});

test("yaml: unsupported syntax throws instead of guessing", () => {
  assert.throws(() => parseYaml("a:\n\t- tab"), /tabs/);
  assert.throws(() => parseYaml("a: 1\n b: 2"), /indentation/);
});
