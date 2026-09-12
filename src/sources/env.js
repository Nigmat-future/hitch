// Keys that already sit in the shell environment. hitch only checks whether a
// variable is set; the value is never read into a record. Pi and OMP resolve
// "$VAR" themselves at request time.
import { keyFromEnv, makeProvider } from "../model.js";

// Only endpoints that Pi and OMP do not ship built in, plus base-URL overrides
// for the ones they do.
const KNOWN = [
  { name: "openai-custom", key: "OPENAI_API_KEY", url: "OPENAI_BASE_URL", api: "openai-responses", requireUrl: true },
  { name: "anthropic-custom", key: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"], url: "ANTHROPIC_BASE_URL", api: "anthropic-messages", requireUrl: true },
  { name: "gemini-custom", key: "GEMINI_API_KEY", url: ["GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL"], api: "google-generative-ai", requireUrl: true },
  { name: "deepseek", key: "DEEPSEEK_API_KEY", url: "DEEPSEEK_BASE_URL", defaultUrl: "https://api.deepseek.com/v1", api: "openai-completions" },
  { name: "moonshot", key: ["MOONSHOT_API_KEY", "KIMI_API_KEY"], url: "MOONSHOT_BASE_URL", defaultUrl: "https://api.moonshot.ai/v1", api: "openai-completions" },
  { name: "dashscope", key: "DASHSCOPE_API_KEY", url: "DASHSCOPE_BASE_URL", defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  { name: "siliconflow", key: "SILICONFLOW_API_KEY", url: "SILICONFLOW_BASE_URL", defaultUrl: "https://api.siliconflow.cn/v1", api: "openai-completions" },
  { name: "minimax", key: "MINIMAX_API_KEY", url: "MINIMAX_BASE_URL", defaultUrl: "https://api.minimax.io/v1", api: "openai-completions" },
  { name: "together", key: "TOGETHER_API_KEY", url: "TOGETHER_BASE_URL", defaultUrl: "https://api.together.xyz/v1", api: "openai-completions" },
  { name: "fireworks", key: "FIREWORKS_API_KEY", url: "FIREWORKS_BASE_URL", defaultUrl: "https://api.fireworks.ai/inference/v1", api: "openai-completions" },
  { name: "perplexity", key: "PERPLEXITY_API_KEY", url: "PERPLEXITY_BASE_URL", defaultUrl: "https://api.perplexity.ai", api: "openai-completions" },
];

const firstSet = (names) => [names].flat().find((n) => process.env[n] !== undefined && process.env[n] !== "");

export default {
  id: "env",
  label: "Environment",
  files: () => [{ path: "(shell environment)", role: `${KNOWN.length} well-known *_API_KEY / *_BASE_URL pairs` }],
  read: () => {
    const providers = [];
    KNOWN.forEach((spec) => {
      const keyVar = firstSet(spec.key);
      if (!keyVar) return;
      const urlVar = firstSet(spec.url);
      if (spec.requireUrl && !urlVar) return;
      const baseUrl = urlVar ? process.env[urlVar] : spec.defaultUrl;
      providers.push(makeProvider({
        source: "env",
        name: spec.name,
        file: `$${keyVar}${urlVar ? ` + $${urlVar}` : ""}`,
        baseUrl,
        api: spec.api,
        key: keyFromEnv(keyVar),
        notes: urlVar ? [] : ["default endpoint for this vendor"],
      }));
    });
    return { providers, problems: [] };
  },
  readSecret: (provider) => process.env[provider.key.env],
};
