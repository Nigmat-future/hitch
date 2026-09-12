// The clickable panel. A tiny HTTP server bound to 127.0.0.1 with a random
// per-run token; the page is one inline HTML file with no external assets.
// No route ever returns a key value: entries are described, and the editor
// sends back instructions for the key that are resolved on this side.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSecret, scan } from "../sources/index.js";
import { TARGET_LIST, targetFor } from "../targets/index.js";
import { KEY_MODES } from "../targets/common.js";
import { applyPlan, connectedIn, planFor, runDiscovery, VERSION } from "../cli.js";
import { buildSpec, describeApiKey, publicEntry, previewText, TARGET_APIS } from "../editor.js";
import { discoverModels } from "../discover.js";
import { displayPath } from "../paths.js";
import { exists, listBackups } from "../fsx.js";
import { isSecretKeyName, redactText } from "../redact.js";

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html");
const MAX_BODY = 256 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const publicProvider = (provider) => {
  const { secretRef, key, ...rest } = provider;
  return {
    ...rest,
    file: displayPath(provider.file),
    key: {
      kind: key.kind,
      env: key.env,
      present: key.present,
      command: key.command ? redactText(key.command) : undefined,
      where: key.where ? displayPath(key.where) : undefined,
    },
    headers: Object.fromEntries(Object.entries(provider.headers ?? {}).filter(([k, v]) => !isSecretKeyName(k) && redactText(v) === v)),
    notes: provider.notes.map(redactText),
  };
};

const publicItem = (item) => ({
  id: item.id,
  name: item.name,
  action: item.action,
  api: item.provider.api,
  baseUrl: item.provider.baseUrl,
  warnings: item.warnings.map(redactText),
  viaHitch: item.viaHitch,
  key: item.entry.apiKey === undefined ? "none" : typeof item.entry.apiKey === "object" ? "copied value" : item.entry.apiKey,
  models: item.entry.models.length,
  discovery: Boolean(item.entry.discovery),
});

const stateForUi = async () => {
  const result = await scan();
  connectedIn(result.providers);
  const targets = TARGET_LIST.map((target) => {
    const state = target.read();
    let entries = [];
    const problems = state.problems.map(redactText);
    try {
      entries = target.listEntries().map(publicEntry);
    } catch (error) {
      problems.push(redactText(error.message));
    }
    return {
      id: target.id,
      label: target.label,
      file: displayPath(state.file),
      exists: state.exists,
      entries,
      apis: TARGET_APIS[target.id],
      problems: [...new Set(problems)],
      backups: exists(state.file) ? listBackups(state.file).length : 0,
    };
  });
  return {
    version: VERSION,
    providers: result.providers.map(publicProvider),
    problems: result.problems.map(redactText),
    sources: result.stats.map((s) => ({ ...s, files: s.files.map((f) => ({ ...f, path: displayPath(f.path), exists: f.path.startsWith("(") ? null : exists(f.path) })) })),
    targets,
    keyModes: KEY_MODES,
  };
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      reject(new HttpError(413, "request too large"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
    } catch {
      reject(new HttpError(400, "invalid JSON body"));
    }
  });
  req.on("error", reject);
});

const openBrowser = (url) => {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : process.platform === "darwin" ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {
    // Printing the URL is enough when no opener is available.
  }
};

// Shared by preview, save and model fetch.
const editorContext = async (body) => {
  const target = targetFor(String(body.target));
  const originalName = body.originalName ? String(body.originalName) : null;
  const existing = originalName ? target.getEntry(originalName) : null;
  if (originalName && !existing) throw new HttpError(409, `"${originalName}" is no longer in ${target.label}. Rescan and try again.`);
  let found = null;
  let all = null;
  if (body.sourceId) {
    all = (await scan({ includeManaged: true })).providers;
    found = all.find((p) => p.id === String(body.sourceId)) ?? null;
    if (!found) throw new HttpError(409, `"${body.sourceId}" was not found on this machine any more. Rescan and try again.`);
  }
  const form = body.form && typeof body.form === "object" ? body.form : {};
  return { target, originalName, existing, found, form, all };
};

const nameConflict = (target, name, originalName) => {
  if (!name || name === originalName) return null;
  const { names } = target.read();
  return names.has(name) ? { field: "name", message: `"${name}" is already used in ${target.label}. Pick another name.` } : null;
};

const discoveryKey = async ({ form, existing, found }) => {
  const key = form.key ?? {};
  switch (key.mode) {
    case "env":
      return process.env[String(key.env ?? "").trim().replace(/^\$/, "")];
    case "value":
      if (String(key.value ?? "").trim()) return String(key.value).trim();
      return describeApiKey(existing?.apiKey).kind === "literal" ? String(existing.apiKey) : undefined;
    case "keep": {
      const described = describeApiKey(existing?.apiKey);
      if (described.kind === "env") return process.env[described.env];
      if (described.kind === "literal") return String(existing.apiKey);
      if (described.kind === "hitch") {
        const providers = (await scan({ includeManaged: true })).providers;
        const source = providers.find((p) => p.id === described.sourceId);
        return source ? readSecret(source) : undefined;
      }
      return undefined;
    }
    case "source":
    case "source-copy":
      return found ? readSecret(found) : undefined;
    default:
      return undefined;
  }
};

const routes = {
  "GET /api/state": async () => stateForUi(),

  "POST /api/preview": async (body) => {
    const ctx = await editorContext(body);
    const result = await buildSpec({ target: ctx.target.id, existing: ctx.existing, form: ctx.form, found: ctx.found });
    const conflict = nameConflict(ctx.target, result.name, ctx.originalName);
    if (conflict) result.errors.push(conflict);
    return { text: previewText(ctx.target.id, result.name, result.spec), errors: result.errors, warnings: result.warnings };
  },

  "POST /api/save": async (body) => {
    const ctx = await editorContext(body);
    const result = await buildSpec({ target: ctx.target.id, existing: ctx.existing, form: ctx.form, found: ctx.found, readFoundSecret: readSecret });
    const conflict = nameConflict(ctx.target, result.name, ctx.originalName);
    if (conflict) result.errors.push(conflict);
    if (result.errors.length) throw new HttpError(422, "Some fields need attention.", { errors: result.errors, warnings: result.warnings });
    const saved = ctx.target.saveEntry({ originalName: ctx.originalName, name: result.name, spec: result.spec, id: ctx.found?.id ?? "manual" });
    return { name: saved.name, file: displayPath(saved.file), backup: saved.backup ? displayPath(saved.backup) : null };
  },

  "POST /api/delete": async (body) => {
    const target = targetFor(String(body.target));
    const result = target.deleteEntry(String(body.name));
    return { removed: result.removed, backup: result.backup ? displayPath(result.backup) : null };
  },

  // The only route that reaches the network: the provider's own /models.
  "POST /api/models": async (body) => {
    const ctx = await editorContext(body);
    const headers = {};
    (Array.isArray(ctx.form.headers) ? ctx.form.headers : []).forEach((row) => {
      const name = String(row?.name ?? "").trim();
      if (!name) return;
      const value = row.keep ? ctx.existing?.headers?.[name] : row.value;
      if (value !== undefined) headers[name] = String(value);
    });
    const provider = { baseUrl: String(ctx.form.baseUrl ?? "").trim().replace(/\/+$/, ""), api: String(ctx.form.api ?? ""), headers };
    try {
      if (!/^https?:$/.test(new URL(provider.baseUrl).protocol)) throw new Error("bad protocol");
    } catch {
      throw new HttpError(400, "Enter a valid endpoint first.");
    }
    const secret = await discoveryKey(ctx);
    const result = await discoverModels(provider, secret);
    return { models: result.models, url: result.url ?? null, error: result.error ? redactText(result.error) : null, usedKey: Boolean(secret) };
  },

  "POST /api/plan": async (body) => {
    const { providers } = await scan();
    const { target, items } = await planFor({ targetId: String(body.target), ids: Array.isArray(body.ids) ? body.ids.map(String) : [], keyMode: String(body.keys ?? "ref"), providers });
    const log = [];
    if (body.discover) await runDiscovery(items, (line) => log.push(line));
    return { target: target.id, items: items.map(publicItem), log };
  },

  "POST /api/apply": async (body) => {
    const { providers } = await scan();
    const { target, items } = await planFor({ targetId: String(body.target), ids: Array.isArray(body.ids) ? body.ids.map(String) : [], keyMode: String(body.keys ?? "ref"), providers });
    const active = items.filter((i) => i.action !== "skip");
    if (!active.length) return { target: target.id, items: items.map(publicItem), written: [] };
    const result = await applyPlan(target, items);
    return { target: target.id, items: items.map(publicItem), written: result.written, backup: result.backup ? displayPath(result.backup) : null, file: displayPath(result.file) };
  },

  "POST /api/undo": async (body) => {
    const result = targetFor(String(body.target)).undo();
    return { restoredFrom: displayPath(result.restoredFrom), remaining: result.remaining };
  },
};

// ctx.origin is filled in once the listening port is known.
export const createServer = (ctx) => http.createServer(async (req, res) => {
  const { token, origin } = ctx;
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (!origin) return send(503, { error: "starting up" });
    const url = new URL(req.url, origin);
    if (String(req.headers.host ?? "") !== new URL(origin).host) return send(421, { error: "wrong host" });
    if (url.pathname === "/" && req.method === "GET") return send(200, fs.readFileSync(HTML, "utf8"), "text/html");
    if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });
    if (req.headers["x-hitch-token"] !== token) return send(401, { error: "Missing or wrong token. Reopen the link hitch printed." });
    if (req.method === "POST" && req.headers.origin && req.headers.origin !== origin) return send(403, { error: "cross-origin request refused" });
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      send(200, { ok: true });
      setTimeout(() => process.exit(0), 50);
      return undefined;
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: "not found" });
    const body = req.method === "POST" ? await readBody(req) : {};
    return send(200, await handler(body));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return send(status, { error: redactText(error.message), ...(error.extra ?? {}) });
  }
});

export const serve = ({ port = 0, open = true, log = console.log } = {}) => new Promise((resolve, reject) => {
  const ctx = { token: crypto.randomBytes(16).toString("hex"), origin: null };
  const server = createServer(ctx);
  server.on("error", reject);
  server.listen(port, "127.0.0.1", () => {
    ctx.origin = `http://127.0.0.1:${server.address().port}`;
    const url = `${ctx.origin}/#${ctx.token}`;
    log(`hitch panel: ${url}`);
    log("Bound to 127.0.0.1 only. Press Ctrl+C or click Quit to end it.");
    if (open) openBrowser(url);
  });
  server.on("close", () => resolve(0));
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});
