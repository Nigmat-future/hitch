// Guards the promises in PRIVACY.md at the source level.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactObject, redactText } from "../src/redact.js";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

const NETWORK_ALLOWED = new Set(["discover.js", path.join("ui", "server.js")]);

test("only discover.js and the local UI server touch the network", () => {
  walk(src).forEach((file) => {
    const rel = path.relative(src, file);
    const text = fs.readFileSync(file, "utf8");
    const usesNetwork = /\bfetch\s*\(|from\s+"node:(http|https|net|dgram|tls|http2)"|require\("node:(http|https|net|dgram|tls)"\)|WebSocket|XMLHttpRequest/.test(text);
    if (NETWORK_ALLOWED.has(rel)) return;
    if (rel === path.join("ui", "index.html")) return; // fetches only its own origin
    assert.equal(usesNetwork, false, `${rel} must not use the network`);
  });
});

test("the UI server binds to loopback only and requires a token", () => {
  const text = fs.readFileSync(path.join(src, "ui", "server.js"), "utf8");
  assert.match(text, /listen\(port, "127\.0\.0\.1"/);
  assert.match(text, /x-hitch-token/);
  assert.ok(!/\/api\/key/.test(text), "no key-returning route in the UI");
});

test("no source file spawns a shell other than the browser opener", () => {
  walk(src).forEach((file) => {
    const rel = path.relative(src, file);
    const text = fs.readFileSync(file, "utf8");
    if (rel === path.join("ui", "server.js")) return;
    assert.equal(/child_process/.test(text), false, `${rel} must not spawn processes`);
  });
});

test("hitch never reads session or history files", () => {
  walk(src).forEach((file) => {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(/sessions?\b.*readFileSync|history\.jsonl|transcripts/.test(text), false, path.relative(src, file));
  });
});

test("redaction masks values under secret-looking keys and known token shapes", () => {
  const out = redactObject({ apiKey: "sk-abcdefghijklmnop", token: "$MY_TOKEN", nested: { Authorization: "Bearer abc", note: "sk-1234567890abcdef inside" } });
  assert.equal(out.apiKey, "sk-…op (19 chars)");
  assert.equal(out.token, "$MY_TOKEN");
  assert.equal(out.nested.Authorization, "Bea…bc (10 chars)");
  assert.equal(redactObject({ secret: "short" }).secret, "••••");
  assert.equal(out.nested.note, "[redacted] inside");
  assert.equal(redactText("Bearer eyJabc.def.ghi"), "Bearer [redacted]");
});
