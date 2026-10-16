/**
 * Redaction of credential-bearing URLs. Newegg answers file-style reports and labels with
 * `ftp://{user}:{password}@ftp03.newegg.com/...` links, so any upstream text that reaches an
 * error, a log line or a tool result must first pass through here. A URL with embedded
 * credentials is a secret - it must never be logged, returned, or placed in an error.
 *
 * Lives under `errors/` because `NeweggError` applies it to every message and `details` payload;
 * `reportmgmt/redact.ts` re-exports it for the report code.
 */

/**
 * `scheme://` (optionally JSON-escaped as `scheme:\/\/`) followed by the userinfo run up to the
 * LAST `@` of the authority. The authority ends at `/`, `\`, `?`, `#`, whitespace or a quote, so
 * `https://host/a@b` and `https://host?email=a@b` are left alone, while a password that itself
 * contains `@` is fully covered. The scheme length is capped to keep the scan linear.
 */
const URL_WITH_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}):(\\?\/\\?\/)[^\s/\\?#"'<>]*@/gi;

const MAX_DEPTH = 32;

/** Replaces the `user:password@` part of any URL inside `text` with `***@`. Never throws. */
export function redactUrlCredentials(text: string): string {
  return typeof text === "string" ? text.replace(URL_WITH_CREDENTIALS, "$1:$2***@") : text;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return redactUrlCredentials(value);
  if (typeof value !== "object" || value === null) return value;
  const isArray = Array.isArray(value);
  // Dates, Maps, class instances etc. are not JSON data: pass them through untouched.
  if (!isArray && !isPlainObject(value)) return value;
  if (seen.has(value) || depth >= MAX_DEPTH) return "[Circular]";
  seen.add(value);
  try {
    if (isArray) return value.map((inner: unknown) => sanitize(inner, seen, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = sanitize(inner, seen, depth + 1);
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Deep-copies a JSON-ish value with every string run through {@link redactUrlCredentials}.
 * Used for every `raw` payload surfaced by the reports API (so `includeRaw` can never leak the
 * download URL's embedded credentials) and for every `NeweggError.details`. Cycles and
 * over-deep nesting are cut off with `"[Circular]"` instead of throwing.
 */
export function sanitizeRaw(value: unknown): unknown {
  return sanitize(value, new WeakSet(), 0);
}
