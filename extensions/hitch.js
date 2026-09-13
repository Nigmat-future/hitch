// Pi extension: the hitch commands inside Pi.
// Every command runs the bundled CLI (bin/hitch.js) in a child process, so the
// promises in PRIVACY.md hold unchanged: key values never reach this file,
// the chat, or a notification.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "hitch.js");
const TARGETS = { pi: "Pi", omp: "Oh My Pi" };

// Pi may run on Node or as a compiled binary; hitch always needs Node 22+.
const nodeBin = () => (/^node(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : "node");

const lastLine = (text) => String(text ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";

// bin/hitch.js already prefixes its errors with "hitch: ".
const errorLine = (text) => lastLine(text).replace(/^hitch: /, "");

export default function hitch(pi) {
  const run = async (args, signal) => {
    const result = await pi.exec(nodeBin(), [BIN, ...args], { signal, timeout: 120000 });
    if (result.code !== 0) throw new Error(errorLine(result.stderr) || lastLine(result.stdout) || `hitch exited with ${result.code}`);
    return result.stdout;
  };

  const refreshModels = async (ctx) => {
    try {
      await ctx.modelRegistry?.refresh?.();
    } catch {
      // Older Pi builds reload models.json when /model opens.
    }
  };

  const report = (ctx, error) => ctx.ui.notify(`hitch: ${error.message ?? error}`, "error");

  pi.registerCommand("hitch", {
    description: "Connect providers from Claude Code, Codex, OpenCode, Factory or CC Switch (/hitch [omp] [ids...])",
    handler: async (args, ctx) => {
      try {
        const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        const targetId = words[0] in TARGETS ? words.shift() : "pi";
        const label = TARGETS[targetId];

        const { providers } = JSON.parse(await run(["scan", "--json"], ctx.signal));
        const open = providers.filter((p) => p.source !== targetId && !p.connected?.[targetId]);
        if (!open.length) {
          ctx.ui.notify(`Nothing new to connect to ${label}. Everything hitch found is already there.`, "info");
          return;
        }

        let ids = words;
        if (!ids.length) {
          const list = open.map((p) => `${p.id}  ${p.baseUrl}`).join("\n");
          if (!ctx.hasUI) {
            ctx.ui.notify(`Found for ${label}:\n${list}\nRun /hitch ${targetId === "pi" ? "" : `${targetId} `}<id> to add one.`, "info");
            return;
          }
          const all = `All ${open.length} providers`;
          const choice = await ctx.ui.select(`Connect to ${label}`, [all, ...open.map((p) => `${p.id}  ${p.baseUrl}`)]);
          if (!choice) return;
          ids = choice === all ? open.map((p) => p.id) : [choice.split(/\s+/)[0]];
        }

        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm(`Add to ${label}?`, `${ids.join(", ")}\nKeys are referenced ($VAR or !hitch key), not copied. A backup is made first.`);
          if (!ok) return;
        }

        const out = await run([targetId, ...ids, "--yes"], ctx.signal);
        if (targetId === "pi") await refreshModels(ctx);
        const wrote = out.split(/\r?\n/).find((line) => line.startsWith("Wrote ")) ?? lastLine(out);
        const next = targetId === "pi" ? "Pick them with /model." : "Restart OMP to pick them up.";
        ctx.ui.notify(`${wrote} ${next} Undo with /hitch-undo${targetId === "pi" ? "" : " omp"}.`, "info");
      } catch (error) {
        report(ctx, error);
      }
    },
  });

  pi.registerCommand("hitch-undo", {
    description: "Restore the models file from the last backup hitch made (/hitch-undo [omp])",
    handler: async (args, ctx) => {
      const targetId = String(args ?? "").trim() in TARGETS ? String(args).trim() : "pi";
      try {
        if (ctx.hasUI && !(await ctx.ui.confirm("Undo hitch?", `Restore ${TARGETS[targetId]}'s models file from hitch's last backup.`))) return;
        const out = await run(["undo", targetId], ctx.signal);
        if (targetId === "pi") await refreshModels(ctx);
        ctx.ui.notify(lastLine(out.split(/\r?\n/)[0]), "info");
      } catch (error) {
        report(ctx, error);
      }
    },
  });

  // The panel is a long-lived loopback server, so it is spawned directly and
  // stopped with the session.
  let panel = null;

  pi.registerCommand("hitch-ui", {
    description: "Open the hitch panel in your browser (127.0.0.1 only)",
    handler: async (_args, ctx) => {
      if (panel?.url) {
        ctx.ui.notify(`hitch panel already running: ${panel.url}`, "info");
        return;
      }
      try {
        const child = spawn(nodeBin(), [BIN, "ui"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        panel = { child, url: null };
        const url = await new Promise((resolve, reject) => {
          let buffer = "";
          const timer = setTimeout(() => reject(new Error("panel did not start within 15s")), 15000);
          child.stdout.on("data", (chunk) => {
            buffer += chunk;
            const match = buffer.match(/hitch panel: (\S+)/);
            if (match) {
              clearTimeout(timer);
              resolve(match[1]);
            }
          });
          child.stderr.on("data", (chunk) => { buffer += chunk; });
          child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(lastLine(buffer) || `panel exited with ${code}`));
          });
        });
        panel.url = url;
        child.on("exit", () => {
          panel = null;
          refreshModels(ctx);
        });
        ctx.ui.notify(`hitch panel: ${url}\nIt stops when you click Quit or close Pi.`, "info");
      } catch (error) {
        panel?.child.kill();
        panel = null;
        report(ctx, error);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    panel?.child.kill();
    panel = null;
  });
}
