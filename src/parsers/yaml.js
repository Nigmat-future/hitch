// A small YAML reader and writer covering the subset that tool config files
// use: block mappings, block sequences, scalars, quoted strings, flow
// collections ([a, b] / {a: 1}), comments and | / > block scalars.
// Anything else throws so callers can degrade gracefully.

const stripComment = (line) => {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};

const unquoteDouble = (raw) => JSON.parse(raw.replace(/\n/g, "\\n"));
const unquoteSingle = (raw) => raw.slice(1, -1).replace(/''/g, "'");

const parseScalar = (raw) => {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return unquoteDouble(text);
  if (/^'(?:[^']|'')*'$/.test(text)) return unquoteSingle(text);
  if (/^[+-]?(?:0|[1-9]\d*)$/.test(text)) return Number(text);
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return Number(text);
  return text;
};

// Flow collections: [a, b, {c: d}]
const parseFlow = (text) => {
  let pos = 0;
  const skip = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
  };
  const readScalar = (stops) => {
    skip();
    if (text[pos] === "\"") {
      const start = pos;
      pos += 1;
      while (pos < text.length && text[pos] !== "\"") pos += text[pos] === "\\" ? 2 : 1;
      pos += 1;
      return unquoteDouble(text.slice(start, pos));
    }
    if (text[pos] === "'") {
      const start = pos;
      pos += 1;
      for (;;) {
        if (pos >= text.length) throw new Error("unterminated single-quoted string");
        if (text[pos] === "'" && text[pos + 1] === "'") pos += 2;
        else if (text[pos] === "'") break;
        else pos += 1;
      }
      pos += 1;
      return unquoteSingle(text.slice(start, pos));
    }
    const start = pos;
    while (pos < text.length && !stops.includes(text[pos])) pos += 1;
    return parseScalar(text.slice(start, pos));
  };
  const value = () => {
    skip();
    const ch = text[pos];
    if (ch === "[") {
      pos += 1;
      const items = [];
      for (;;) {
        skip();
        if (text[pos] === "]") {
          pos += 1;
          return items;
        }
        items.push(value());
        skip();
        if (text[pos] === ",") pos += 1;
        else if (text[pos] !== "]") throw new Error("expected , or ] in flow sequence");
      }
    }
    if (ch === "{") {
      pos += 1;
      const map = {};
      for (;;) {
        skip();
        if (text[pos] === "}") {
          pos += 1;
          return map;
        }
        const key = readScalar([":", ",", "}"]);
        skip();
        if (text[pos] === ":") {
          pos += 1;
          map[String(key)] = value();
        } else map[String(key)] = null;
        skip();
        if (text[pos] === ",") pos += 1;
        else if (text[pos] !== "}") throw new Error("expected , or } in flow mapping");
      }
    }
    return readScalar([",", "]", "}"]);
  };
  const result = value();
  skip();
  if (pos < text.length) throw new Error("trailing content after flow collection");
  return result;
};

const splitKeyValue = (content) => {
  // Returns [key, rest] when the content is a mapping entry, else null.
  let i = 0;
  let key;
  if (content[0] === "\"" || content[0] === "'") {
    const quote = content[0];
    i = 1;
    while (i < content.length) {
      if (quote === "\"" && content[i] === "\\") i += 2;
      else if (content[i] === quote) {
        if (quote === "'" && content[i + 1] === "'") i += 2;
        else break;
      } else i += 1;
    }
    key = quote === "\"" ? unquoteDouble(content.slice(0, i + 1)) : unquoteSingle(content.slice(0, i + 1));
    i += 1;
  } else {
    if (content[0] === "[" || content[0] === "{") return null;
    const match = /^([^\s:][^:]*?)?\s*:(?=\s|$)/.exec(content);
    if (!match) return null;
    key = (match[1] ?? "").trim();
    return [key, content.slice(match[0].length).trim()];
  }
  const rest = content.slice(i);
  const match = /^\s*:(?=\s|$)/.exec(rest);
  if (!match) return null;
  return [String(key), rest.slice(match[0].length).trim()];
};

const isFlowStart = (text) => text.startsWith("[") || text.startsWith("{");
const flowBalanced = (text) => {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === "\"") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
  }
  return depth <= 0 && !quote;
};

export const parseYaml = (text) => {
  const rawLines = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const lines = [];
  rawLines.forEach((raw, index) => {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw) || /^%/.test(raw)) return;
    const stripped = stripComment(raw);
    if (!stripped.trim()) return;
    const indent = stripped.match(/^ */)[0].length;
    if (/^\t/.test(stripped)) throw new Error(`tabs are not allowed for indentation (line ${index + 1})`);
    lines.push({ indent, content: stripped.trim(), raw, line: index + 1 });
  });
  let pos = 0;

  const readBlockScalar = (indicator, parentIndent) => {
    const folded = indicator.startsWith(">");
    const keep = indicator.includes("+");
    const strip = indicator.includes("-");
    const collected = [];
    let blockIndent = null;
    while (pos < lines.length && lines[pos].indent > parentIndent) {
      const entry = lines[pos];
      if (blockIndent === null) blockIndent = entry.indent;
      collected.push(entry.raw.slice(blockIndent));
      pos += 1;
    }
    let value = folded ? collected.join(" ") : collected.join("\n");
    if (!strip) value += "\n";
    if (!keep) value = value.replace(/\n+$/, strip ? "" : "\n");
    return value;
  };

  const readInline = (rest, parentIndent) => {
    if (rest === "") return undefined;
    if (/^[|>][+-]?\d*$/.test(rest)) return readBlockScalar(rest, parentIndent);
    if (isFlowStart(rest)) {
      let joined = rest;
      while (!flowBalanced(joined) && pos < lines.length) {
        joined += ` ${lines[pos].content}`;
        pos += 1;
      }
      return parseFlow(joined);
    }
    return parseScalar(rest);
  };

  const parseBlock = (indent) => {
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.content === "-" || first.content.startsWith("- ")) return parseSequence(first.indent);
    return parseMapping(first.indent);
  };

  const parseMapping = (indent) => {
    const map = {};
    while (pos < lines.length) {
      const entry = lines[pos];
      if (entry.indent < indent) break;
      if (entry.indent > indent) throw new Error(`unexpected indentation at line ${entry.line}`);
      if (entry.content === "-" || entry.content.startsWith("- ")) break;
      const kv = splitKeyValue(entry.content);
      if (!kv) throw new Error(`expected "key: value" at line ${entry.line}`);
      const [key, rest] = kv;
      pos += 1;
      let value = readInline(rest, indent);
      if (value === undefined) {
        if (pos < lines.length && (lines[pos].indent > indent
          || (lines[pos].indent === indent && (lines[pos].content === "-" || lines[pos].content.startsWith("- "))))) {
          value = parseBlock(lines[pos].indent);
        } else value = null;
      }
      map[key] = value;
    }
    return map;
  };

  const parseSequence = (indent) => {
    const items = [];
    while (pos < lines.length) {
      const entry = lines[pos];
      if (entry.indent < indent) break;
      if (entry.indent > indent) throw new Error(`unexpected indentation at line ${entry.line}`);
      if (!(entry.content === "-" || entry.content.startsWith("- "))) break;
      const rest = entry.content === "-" ? "" : entry.content.slice(2).trim();
      pos += 1;
      if (rest === "") {
        if (pos < lines.length && lines[pos].indent > indent) items.push(parseBlock(lines[pos].indent));
        else items.push(null);
        continue;
      }
      const kv = isFlowStart(rest) ? null : splitKeyValue(rest);
      if (kv) {
        // Mapping that starts on the dash line; its keys sit at indent + 2.
        const itemIndent = indent + 2;
        lines.splice(pos, 0, { indent: itemIndent, content: rest, raw: " ".repeat(itemIndent) + rest, line: entry.line });
        items.push(parseMapping(itemIndent));
        continue;
      }
      items.push(readInline(rest, indent));
    }
    return items;
  };

  if (lines.length === 0) return null;
  const result = parseBlock(lines[0].indent);
  if (pos < lines.length) throw new Error(`unexpected content at line ${lines[pos].line}`);
  return result;
};

const PLAIN_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_.\/+:@-]*$/;
const LOOKS_SPECIAL = /^(true|false|null|~|yes|no|on|off|[+-]?\d[\d_]*(\.\d*)?([eE][+-]?\d+)?|0x[0-9a-fA-F]+)$/i;

export const yamlScalar = (value) => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  if (PLAIN_SAFE.test(text) && !LOOKS_SPECIAL.test(text) && !text.includes(": ") && !text.endsWith(":")) return text;
  return JSON.stringify(text);
};

// Emits block YAML for plain objects / arrays. Arrays of scalars use flow
// style ([text, image]) to match how Pi and OMP document their formats.
export const emitYaml = (value, indent = 0) => {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    if (value.every((item) => item === null || typeof item !== "object")) {
      return `${pad}[${value.map(yamlScalar).join(", ")}]\n`;
    }
    return value.map((item) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const body = emitYaml(item, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      }
      return `${pad}- ${yamlScalar(item)}\n`;
    }).join("");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return `${pad}{}\n`;
    return entries.map(([key, v]) => {
      const k = yamlScalar(key);
      if (v !== null && typeof v === "object") {
        const isScalarArray = Array.isArray(v) && v.every((item) => item === null || typeof item !== "object");
        const isEmpty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
        if (isScalarArray || isEmpty) return `${pad}${k}: ${emitYaml(v, 0)}`;
        return `${pad}${k}:\n${emitYaml(v, indent + 2)}`;
      }
      return `${pad}${k}: ${yamlScalar(v)}\n`;
    }).join("");
  }
  return `${pad}${yamlScalar(value)}\n`;
};
