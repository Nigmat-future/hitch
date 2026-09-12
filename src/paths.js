// The complete list of files hitch may read or write. `hitch sources`
// prints this so users can see exactly where it looks. Nothing outside
// this list is ever opened.
import os from "node:os";
import path from "node:path";

export const home = () => process.env.HITCH_HOME_OVERRIDE || os.homedir();

const under = (...parts) => path.join(home(), ...parts);

const xdgData = () => process.env.XDG_DATA_HOME || under(".local", "share");
const xdgConfig = () => process.env.XDG_CONFIG_HOME || under(".config");

export const paths = () => ({
  claude: {
    settings: process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json") : under(".claude", "settings.json"),
  },
  codex: {
    config: path.join(process.env.CODEX_HOME || under(".codex"), "config.toml"),
    auth: path.join(process.env.CODEX_HOME || under(".codex"), "auth.json"),
  },
  opencode: {
    config: path.join(xdgConfig(), "opencode", "opencode.json"),
    configJsonc: path.join(xdgConfig(), "opencode", "opencode.jsonc"),
    auth: path.join(xdgData(), "opencode", "auth.json"),
  },
  factory: {
    settings: under(".factory", "settings.json"),
    config: under(".factory", "config.json"),
  },
  pi: {
    models: process.env.PI_MODELS_PATH || under(".pi", "agent", "models.json"),
  },
  omp: {
    models: process.env.OMP_MODELS_PATH || under(".omp", "agent", "models.yml"),
  },
  hitch: {
    dir: process.env.HITCH_STATE_DIR || under(".hitch"),
    state: path.join(process.env.HITCH_STATE_DIR || under(".hitch"), "state.json"),
  },
});

export const displayPath = (file) => {
  const h = home();
  const normalized = String(file ?? "");
  if (normalized.startsWith(h)) return `~${normalized.slice(h.length).replace(/\\/g, "/")}`;
  return normalized.replace(/\\/g, "/");
};
