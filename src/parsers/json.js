// JSON with comments and trailing commas (the dialect opencode.jsonc and
// editors produce). Strips comments outside of strings, then removes
// trailing commas before } or ].
const stripComments = (text) => {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === "\"") inString = false;
      i += 1;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

const stripTrailingCommas = (text) => text.replace(/,(\s*[}\]])/g, "$1");

export const parseJsonc = (text) => {
  const cleaned = String(text ?? "").replace(/^﻿/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return JSON.parse(stripTrailingCommas(stripComments(cleaned)));
  }
};
