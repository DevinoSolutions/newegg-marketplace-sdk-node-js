/**
 * Redaction of credential-bearing URLs. Newegg answers file-style reports and labels with
 * `ftp://{user}:{password}@ftp03.newegg.com/...` links, so any upstream text that reaches an
 * error, a log line or a tool result must first pass through here. A URL with embedded
 * credentials is a secret - it must never be logged, returned, or placed in an error.
 *
 * Lives under `errors/` because `NeweggError` applies it to every message, `details` payload and
 * `cause`; `reportmgmt/redact.ts` re-exports it for the report code.
 *
 * Every pattern is linear-time: scheme, user and password runs are length-capped or stop at a
 * delimiter, and the looser patterns are anchored on a following `newegg.com` host, so no input
 * can make the scan backtrack catastrophically (see the 500k-character performance test).
 *
 * Known limits: a password containing whitespace (a space ends a URL), a schemeless
 * `user:password@host` on a host other than a Newegg FTP report host, and encodings nested more
 * than twice are not recognized.
 */

/**
 * `scheme://` (also `scheme:///`, `scheme:\\` and the JSON-escaped `scheme:\/\/`) followed by the
 * userinfo run up to the LAST `@` of the authority. The authority ends at `/`, `\`, `?`, `#`,
 * whitespace or a quote, so `https://host/a@b` and `https://host?email=a@b` are left alone, while
 * a password that itself contains `@` is fully covered. The scheme length is capped to keep the
 * scan linear, and there is deliberately no leading word boundary, so `link_ftp://u:p@h` is
 * redacted too.
 */
const URL_WITH_CREDENTIALS = /([a-z][a-z0-9+.-]{0,31}):([\\/]{2,6})[^\s/\\?#"'<>]*@/gi;

/** A host at or under `newegg.com`; used only as a lookahead anchor for the looser patterns. */
const NEWEGG_HOST = String.raw`(?:[a-z0-9-]+\.)*newegg\.com(?![\w-])`;

/**
 * A password holding a literal `/ ? # "`, which ends the pattern above early. When a `newegg.com`
 * host follows, scan lazily (at most 256 characters) to the FIRST `@` that introduces it, so text
 * after the URL is not swallowed.
 */
const URL_WITH_RESERVED_CHARS_IN_PASSWORD = new RegExp(
  String.raw`([a-z][a-z0-9+.-]{0,31}):([\\/]{2,6})[^\s'<>]{0,256}?@(?=${NEWEGG_HOST})`,
  "gi",
);

/** Scheme-relative `//user:password@host`. A `user:` part is required, so `//a@b` is untouched. */
const SCHEME_RELATIVE_CREDENTIALS = /(?<![\w:/\\.%-])(\/\/)[^\s:/\\?#"'<>@]+:[^\s/\\?#"'<>]*@/g;

/**
 * Schemeless `user:password@ftp03.newegg.com`. Restricted to Newegg's FTP report hosts and to a
 * token start, so ordinary `label:value@host` text and e-mail addresses keep their meaning; user
 * and password lengths are capped to keep the scan linear.
 */
const SCHEMELESS_CREDENTIALS = new RegExp(
  String.raw`(?<![^\s"'<>(\[{,;=|])[^\s:/\\@?#"'<>=,;()\[\]{}|]{1,128}:[^\s/\\"'<>]{0,256}@(?=[\w.-]*ftp[\w.-]*\.newegg\.com(?![\w-]))`,
  "gi",
);

/** Cheap pre-check: is there any percent / HTML-entity / fullwidth spelling worth decoding? */
const ENCODED_DELIMITER_HINT = /%(?:3a|2f|5c|40|ef|25)|&#x?0*(?:64|40);|\uFF20/i;

/**
 * Decodes ONLY the URL delimiters (`: / \ @`, in their percent, HTML-entity and fullwidth
 * spellings) so an encoded URL such as `ftp%3A%2F%2Fu%3Ap%40h` becomes visible to the patterns
 * above. Run twice, which also unwraps one level of double encoding (`%2540`).
 */
function decodeDelimiters(text: string): string {
  let current = text;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = current.replace(
      /%(?:3a|2f|5c|40)|%ef%bc%a0|&#0*64;|&#x0*40;|\uFF20|%25(?=[0-9a-f]{2})/gi,
      (match) => {
        switch (match.toLowerCase()) {
          case "%3a":
            return ":";
          case "%2f":
            return "/";
          case "%5c":
            return "\\";
          case "%25":
            return "%";
          default:
            return "@";
        }
      },
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

function redactVisible(text: string): string {
  return text
    .replace(URL_WITH_CREDENTIALS, "$1:$2***@")
    .replace(URL_WITH_RESERVED_CHARS_IN_PASSWORD, "$1:$2***@")
    .replace(SCHEME_RELATIVE_CREDENTIALS, "$1***@")
    .replace(SCHEMELESS_CREDENTIALS, "***@");
}

/**
 * Replaces the `user:password@` part of any URL inside `text` with `***@`, whatever its spelling:
 * `scheme://`, `scheme:///`, backslashes, scheme-relative `//`, schemeless on a Newegg FTP host,
 * JSON-escaped, and (after a delimiter-decoding pass) percent-encoded, HTML-entity or
 * fullwidth-`@` forms. Never throws.
 */
export function redactUrlCredentials(text: string): string {
  if (typeof text !== "string") return text;
  const direct = redactVisible(text);
  if (!ENCODED_DELIMITER_HINT.test(text)) return direct;
  const decoded = decodeDelimiters(text);
  const fromDecoded = redactVisible(decoded);
  // Only surface the decoded spelling when decoding revealed something to redact.
  return fromDecoded !== decoded ? fromDecoded : direct;
}

const MAX_DEPTH = 32;

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

const MAX_CAUSE_DEPTH = 8;

function sanitizeCauseValue(value: unknown, path: readonly object[]): unknown {
  if (typeof value === "string") return redactUrlCredentials(value);
  if (typeof value !== "object" || value === null) return value;
  if (path.includes(value)) return "[Circular]";
  if (path.length >= MAX_CAUSE_DEPTH) return "[Truncated]";
  if (value instanceof Error) {
    // An Error keeps its identity unless a redaction actually changes one of its own properties
    // (message, stack, a string field, a nested cause); then a same-class copy replaces it.
    const next = [...path, value];
    const changed = new Map<string | symbol, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const cleaned = sanitizeCauseValue(descriptor.value, next);
      if (cleaned !== descriptor.value) changed.set(key, { ...descriptor, value: cleaned });
    }
    if (changed.size === 0) return value;
    const clone = Object.create(Object.getPrototypeOf(value) as object | null) as Error;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = changed.get(key) ?? Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined) Object.defineProperty(clone, key, descriptor);
    }
    return clone;
  }
  if (Array.isArray(value) || isPlainObject(value)) return sanitizeRaw(value);
  return value;
}

/**
 * Returns `cause` with URL credentials removed from its message, stack, string properties and
 * nested causes, so `console.log(error)` / `util.inspect(error)` (which print the whole cause
 * chain) cannot leak them. An `Error` with nothing to redact is returned as-is (same identity);
 * otherwise a same-class copy is returned and the original is never mutated.
 */
export function sanitizeCause(cause: unknown): unknown {
  return sanitizeCauseValue(cause, []);
}
