// A deliberately small TOML reader: enough for ~/.codex/config.toml
// (tables, dotted tables, arrays of tables, strings, numbers, booleans,
// arrays and inline tables). Unsupported syntax throws.

class Cursor {
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }
  peek(offset = 0) {
    return this.text[this.pos + offset];
  }
  eof() {
    return this.pos >= this.text.length;
  }
  skipWs(newlines = false) {
    for (;;) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || (newlines && (ch === "\n" || ch === "\r"))) this.pos += 1;
      else if (ch === "#") {
        while (!this.eof() && this.peek() !== "\n") this.pos += 1;
        if (!newlines) return;
      } else return;
    }
  }
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", "\"": "\"", "\\": "\\", b: "\b", f: "\f" };

const parseBasicString = (c, multiline) => {
  let out = "";
  for (;;) {
    if (c.eof()) throw new Error("unterminated string");
    const ch = c.peek();
    if (multiline && ch === "\"" && c.peek(1) === "\"" && c.peek(2) === "\"") {
      c.pos += 3;
      return out;
    }
    if (!multiline && ch === "\"") {
      c.pos += 1;
      return out;
    }
    if (ch === "\\") {
      const esc = c.peek(1);
      if (esc in ESCAPES) {
        out += ESCAPES[esc];
        c.pos += 2;
        continue;
      }
      if (esc === "u" || esc === "U") {
        const len = esc === "u" ? 4 : 8;
        const hex = c.text.slice(c.pos + 2, c.pos + 2 + len);
        out += String.fromCodePoint(parseInt(hex, 16));
        c.pos += 2 + len;
        continue;
      }
      if (multiline && (esc === "\n" || esc === "\r" || esc === " " || esc === "\t")) {
        c.pos += 1;
        c.skipWs(true);
        continue;
      }
      throw new Error(`bad escape \\${esc}`);
    }
    out += ch;
    c.pos += 1;
  }
};

const parseLiteralString = (c, multiline) => {
  const end = multiline ? "'''" : "'";
  const stop = c.text.indexOf(end, c.pos);
  if (stop < 0) throw new Error("unterminated literal string");
  const out = c.text.slice(c.pos, stop);
  c.pos = stop + end.length;
  return out;
};

const parseKeyPart = (c) => {
  c.skipWs();
  const ch = c.peek();
  if (ch === "\"") {
    c.pos += 1;
    return parseBasicString(c, false);
  }
  if (ch === "'") {
    c.pos += 1;
    return parseLiteralString(c, false);
  }
  const match = /^[A-Za-z0-9_-]+/.exec(c.text.slice(c.pos));
  if (!match) throw new Error(`bad key at offset ${c.pos}`);
  c.pos += match[0].length;
  return match[0];
};

const parseKeyPath = (c) => {
  const parts = [parseKeyPart(c)];
  c.skipWs();
  while (c.peek() === ".") {
    c.pos += 1;
    parts.push(parseKeyPart(c));
    c.skipWs();
  }
  return parts;
};

const SCALAR = /^(true|false|[+-]?(?:inf|nan)|[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)|\d{4}-\d{2}-\d{2}(?:[Tt ][\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;

const parseValue = (c) => {
  c.skipWs();
  const ch = c.peek();
  if (ch === "\"") {
    if (c.peek(1) === "\"" && c.peek(2) === "\"") {
      c.pos += 3;
      if (c.peek() === "\n") c.pos += 1;
      else if (c.peek() === "\r" && c.peek(1) === "\n") c.pos += 2;
      return parseBasicString(c, true);
    }
    c.pos += 1;
    return parseBasicString(c, false);
  }
  if (ch === "'") {
    if (c.peek(1) === "'" && c.peek(2) === "'") {
      c.pos += 3;
      if (c.peek() === "\n") c.pos += 1;
      return parseLiteralString(c, true);
    }
    c.pos += 1;
    return parseLiteralString(c, false);
  }
  if (ch === "[") {
    c.pos += 1;
    const items = [];
    for (;;) {
      c.skipWs(true);
      if (c.peek() === "]") {
        c.pos += 1;
        return items;
      }
      items.push(parseValue(c));
      c.skipWs(true);
      if (c.peek() === ",") c.pos += 1;
      else if (c.peek() !== "]") throw new Error("expected , or ] in array");
    }
  }
  if (ch === "{") {
    c.pos += 1;
    const table = {};
    c.skipWs();
    if (c.peek() === "}") {
      c.pos += 1;
      return table;
    }
    for (;;) {
      const path = parseKeyPath(c);
      c.skipWs();
      if (c.peek() !== "=") throw new Error("expected = in inline table");
      c.pos += 1;
      assign(table, path, parseValue(c));
      c.skipWs();
      if (c.peek() === ",") {
        c.pos += 1;
        continue;
      }
      if (c.peek() === "}") {
        c.pos += 1;
        return table;
      }
      throw new Error("expected , or } in inline table");
    }
  }
  const scalar = SCALAR.exec(c.text.slice(c.pos));
  if (!scalar) throw new Error(`bad value at offset ${c.pos}`);
  c.pos += scalar[0].length;
  const raw = scalar[0];
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?(inf|nan)$/.test(raw)) {
    if (raw.endsWith("nan")) return NaN;
    return raw.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) || /^\d{2}:\d{2}:\d{2}/.test(raw)) return raw;
  return Number(raw.replace(/_/g, ""));
};

const isTable = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const assign = (target, path, value) => {
  let node = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (node[key] === undefined) node[key] = {};
    if (Array.isArray(node[key])) node = node[key][node[key].length - 1];
    else if (isTable(node[key])) node = node[key];
    else throw new Error(`key ${path.join(".")} conflicts with an existing value`);
  }
  const last = path[path.length - 1];
  if (last in node) throw new Error(`duplicate key ${path.join(".")}`);
  node[last] = value;
};

const tableAt = (root, path, { array = false } = {}) => {
  let node = root;
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i];
    const isLast = i === path.length - 1;
    if (isLast && array) {
      if (node[key] === undefined) node[key] = [];
      if (!Array.isArray(node[key])) throw new Error(`${path.join(".")} is not an array of tables`);
      const table = {};
      node[key].push(table);
      return table;
    }
    if (node[key] === undefined) node[key] = {};
    if (Array.isArray(node[key])) node = node[key][node[key].length - 1];
    else if (isTable(node[key])) node = node[key];
    else throw new Error(`${path.join(".")} is not a table`);
  }
  return node;
};

export const parseToml = (text) => {
  const root = {};
  let current = root;
  const c = new Cursor(String(text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n"));
  for (;;) {
    c.skipWs(true);
    if (c.eof()) return root;
    if (c.peek() === "[") {
      const isArray = c.peek(1) === "[";
      c.pos += isArray ? 2 : 1;
      const path = parseKeyPath(c);
      c.skipWs();
      const close = isArray ? "]]" : "]";
      if (c.text.slice(c.pos, c.pos + close.length) !== close) throw new Error("expected closing bracket for table header");
      c.pos += close.length;
      current = tableAt(root, path, { array: isArray });
      continue;
    }
    const path = parseKeyPath(c);
    c.skipWs();
    if (c.peek() !== "=") throw new Error(`expected = after key ${path.join(".")}`);
    c.pos += 1;
    const value = parseValue(c);
    assign(current, path, value);
    c.skipWs();
    if (!c.eof() && c.peek() !== "\n") throw new Error(`unexpected content after value for ${path.join(".")}`);
  }
};
