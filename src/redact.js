// Everything hitch prints or serialises for display passes through here.
// Secrets are never held on provider records, but defence in depth is cheap.

const SECRET_KEY = /(api[-_]?key|auth[-_]?token|token|secret|password|passwd|credential|authorization|cookie|bearer)/i;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_-]{8,}|cr_[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|xox[abp]-[A-Za-z0-9-]{10,})\b/g;
const BEARER = /(Bearer\s+)[^\s"']+/gi;

export const isSecretKeyName = (name) => SECRET_KEY.test(String(name ?? ""));

// Reference forms ($ENV, !command, {env:X}, ${X}) are not secrets and stay visible.
export const isReference = (value) => {
  const text = String(value ?? "");
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(text) || /^\$\{[^}]+\}/.test(text) || text.startsWith("!") || /^\{(env|file):[^}]+\}$/.test(text);
};

export const maskValue = (value) => {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 3)}…${text.slice(-2)} (${text.length} chars)`;
};

export const redactText = (text) => String(text ?? "")
  .replace(SECRET_VALUE, "[redacted]")
  .replace(BEARER, "$1[redacted]");

// Deep-copies a structure masking any value under a secret-looking key.
export const redactObject = (value, keyName = "") => {
  if (Array.isArray(value)) return value.map((item) => redactObject(item, keyName));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactObject(v, k)]));
  }
  if (typeof value === "string") {
    if (isSecretKeyName(keyName) && !isReference(value)) return maskValue(value);
    return redactText(value);
  }
  return value;
};
