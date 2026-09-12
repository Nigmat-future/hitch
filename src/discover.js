// The one module allowed to open a network connection, and only when the
// user passes --discover. It asks the provider's own /models endpoint for
// model ids using the provider's own key, which is the endpoint that key was
// issued for. Nothing is sent anywhere else. test/privacy.test.js enforces
// that no other file imports fetch/http.

const TIMEOUT_MS = 8000;

const candidates = (provider) => {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (provider.api === "anthropic-messages") {
    return /\/v1$/.test(base) ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
  }
  if (provider.api === "google-generative-ai") return [];
  return /\/v\d+$/.test(base) ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
};

const headersFor = (provider, secret) => {
  const headers = { accept: "application/json" };
  Object.entries(provider.headers ?? {}).forEach(([k, v]) => {
    if (!String(v).startsWith("$")) headers[k] = String(v);
  });
  if (provider.api === "anthropic-messages") {
    if (secret) headers["x-api-key"] = secret;
    headers["anthropic-version"] = "2023-06-01";
  } else if (secret) headers.authorization = `Bearer ${secret}`;
  return headers;
};

export const discoverModels = async (provider, secret, { fetchImpl = globalThis.fetch } = {}) => {
  const urls = candidates(provider);
  if (!urls.length) return { models: [], error: "model discovery is not supported for this API type" };
  let lastError = "no response";
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { headers: headersFor(provider, secret), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) {
        lastError = `${url} answered ${response.status}`;
        continue;
      }
      const body = await response.json();
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      const models = list
        .map((m) => (typeof m === "string" ? { id: m } : m && typeof m === "object" ? { id: m.id ?? m.name, name: m.display_name } : null))
        .filter((m) => m && typeof m.id === "string" && m.id)
        .map((m) => (m.name ? { id: m.id, name: m.name } : { id: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models, url };
    } catch (error) {
      lastError = `${url}: ${error.name === "TimeoutError" ? "timed out" : error.message}`;
    }
  }
  return { models: [], error: lastError };
};
