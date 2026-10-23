/**
 * Redaction for anything the MCP server writes to its logs. Unexpected errors (a failed `fetch`,
 * a library bug) can carry full URLs in their message or stack: credentials in the userinfo, or a
 * query string such as `?sellerid=...`. Both are removed before the text reaches a log sink that
 * may be shipped to a log service or pasted into a ticket.
 */
import { redactUrlCredentials } from "@devino/newegg-marketplace-sdk";

/** Ends the part of a URL before its query: whitespace, another `?`, a fragment, a quote or a bracket. */
const URL_PART_END = /[\s?#"'<>]/;
/** Ends a query string. */
const QUERY_END = /[\s#"'<>]/;

/**
 * `http(s)://host/path?query#frag` -> `http(s)://host/path?[redacted]#frag`. One forward pass with
 * `indexOf` (no backtracking regex), so a pathological input such as `a://` repeated cannot make
 * it quadratic: each scanned stretch starts where the previous one ended. There is no cap on how
 * far the part before the `?` may run, so a very long path cannot keep its query in a log.
 */
function redactQueryStrings(text: string): string {
  if (!text.includes("?")) return text;
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const separator = text.indexOf("://", from);
    if (separator < 0) break;
    const start = separator + 3;
    let end = start;
    while (end < text.length && !URL_PART_END.test(text.charAt(end))) end += 1;
    if (end < text.length && text.charAt(end) === "?") {
      let queryEnd = end + 1;
      while (queryEnd < text.length && !QUERY_END.test(text.charAt(queryEnd))) queryEnd += 1;
      out += `${text.slice(copied, end + 1)}[redacted]`;
      copied = queryEnd;
      from = queryEnd;
    } else {
      from = end;
    }
  }
  return out + text.slice(copied);
}

/**
 * Credential names, as words joined by an optional `-` or `_`. Kept in step with the SDK's cause
 * redaction (`packages/sdk/src/errors/redact.ts`, which does not export it); a test asserts that
 * both cover the same names.
 */
const CREDENTIAL_WORDS: readonly (readonly string[])[] = [
  ["seller", "id"],
  ["secret", "key"],
  ["x", "secret", "key"],
  ["api", "key"],
  ["x", "api", "key"],
  ["authorization"],
  ["proxy", "authorization"],
  ["x", "auth"],
  ["x", "auth", "token"],
  ["auth", "token"],
  ["access", "token"],
  ["refresh", "token"],
  ["id", "token"],
  ["client", "secret"],
  ["x", "token"],
  ["token"],
  ["password"],
  ["passwd"],
  ["secret"],
];

/**
 * Names that are HTTP headers (`Authorization`, `SecretKey`, `X-Api-Key`, any `x-*`): only these
 * are masked after a bare `name: value`. For the generic words (`token`, `password`, `secret`, ...)
 * a colon is ordinary prose (`Unexpected token: } in JSON`, `password: must be at least 8
 * characters`), so they need `=`, a quoted name (`"token": "..."`) or a quoted value
 * (`{ token: '...' }`). Kept in step with the SDK.
 */
const HEADER_LIKE_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxyauthorization",
  "secretkey",
  "apikey",
]);

const isHeaderLike = (words: readonly string[]): boolean =>
  words[0] === "x" || HEADER_LIKE_NAMES.has(words.join(""));

/** The alternation of `list` as name patterns, longest first so `x-auth-token` wins over `x-auth`. */
const namePattern = (list: readonly (readonly string[])[]): string =>
  [...list]
    .sort((a, b) => b.join("").length - a.join("").length)
    .map((words) => words.join("[-_]?"))
    .join("|");

const HEADER_LIKE_PATTERN = namePattern(CREDENTIAL_WORDS.filter(isHeaderLike));
const GENERIC_PATTERN = namePattern(CREDENTIAL_WORDS.filter((words) => !isHeaderLike(words)));

/**
 * Credential-bearing values wherever they appear, with or without a `scheme://` in front:
 * `GET /x?sellerid=... HTTP/1.1`, `Authorization: Bearer ...`, `"SecretKey":"..."`. `name=value`,
 * `"name":"value"` and `{ name: 'value' }` match for any credential name, `name: value` for a
 * header-like one. A Bearer / Basic / Digest scheme word is part of the value; the value ends at a
 * delimiter, so a following comma survives. No nested quantifiers, so it is linear. Groups 1 and 2
 * are a header-like name and its separator, 3 and 4 a generic name and its separator.
 */
const CREDENTIAL_TEXT = new RegExp(
  String.raw`(?<![\w.-])(?:(${HEADER_LIKE_PATTERN})(["']?\s*[:=]\s*["']?)|(${GENERIC_PATTERN})(["']?\s*=\s*["']?|["']\s*:\s*["']?|\s*:\s*["']))((?:(?:bearer|basic|digest)\s+)?[^&\s#"'<>,;]+)`,
  "gi",
);

/**
 * A `Cookie` / `Set-Cookie` line. After a colon the value runs to the end of the line (a cookie holds
 * `;` and spaces), after `=` to the next delimiter; a quoted value ends at its closing quote.
 */
const COOKIE_TEXT =
  /(?<![\w.-])(set[-_]?cookie|cookie)(?:(["']?\s*:\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)|(["']?\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^&\s#"'<>]+))/gi;

const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;

/** The characters that end a credential value. */
const VALUE_END_CHAR = /[\s&#"'<>,;]/;

/**
 * Decodes the ASCII percent escapes (up to three layers), so `%73ellerid%3DX` becomes visible. An
 * escape of a character that ends a credential value (`%26`, `%3B`, `%2C`, `%23`, `%20`, a quote,
 * ...) stays encoded: decoding it would end the value early and leave the rest of it in the text.
 */
function decodePercent(text: string): string {
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    const next = current.replace(PERCENT_ESCAPE, (match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code < 0x80 && !VALUE_END_CHAR.test(String.fromCharCode(code))
        ? String.fromCharCode(code)
        : match;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

const REDACTED = "[redacted]";

/** Masks a cookie value, keeping its quotes (`"cookie":"a=b"` -> `"cookie":"[redacted]"`). */
function maskCookieValue(value: string): string {
  const quote = value.startsWith('"') || value.startsWith("'") ? value.charAt(0) : "";
  return quote !== "" && value.length > 1 && value.endsWith(quote)
    ? `${quote}${REDACTED}${quote}`
    : `${quote}${REDACTED}`;
}

const maskCredentials = (text: string): string =>
  text
    .replace(
      COOKIE_TEXT,
      (
        _match,
        name: string,
        colon: string | undefined,
        colonValue: string | undefined,
        equals: string | undefined,
        equalsValue: string | undefined,
      ) => `${name}${colon ?? equals ?? ""}${maskCookieValue(colonValue ?? equalsValue ?? "")}`,
    )
    .replace(
      CREDENTIAL_TEXT,
      (
        _match,
        headerName: string | undefined,
        headerSeparator: string | undefined,
        name: string | undefined,
        separator: string | undefined,
      ) => `${headerName ?? name ?? ""}${headerSeparator ?? separator ?? ""}${REDACTED}`,
    );

/** Removes URL credentials, URL query strings and credential values from `text`. Never throws. */
export function redactLogText(text: string): string {
  const base = redactQueryStrings(redactUrlCredentials(text));
  const direct = maskCredentials(base);
  if (!base.includes("%")) return direct;
  const decoded = decodePercent(base);
  if (decoded === base) return direct;
  const fromDecoded = maskCredentials(decoded);
  return fromDecoded !== decoded ? fromDecoded : direct;
}

const MAX_DEPTH = 6;

/** Deep-copies log `fields`, passing every string through {@link redactLogText}. */
export function redactLogFields(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (typeof value !== "object" || value === null || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((inner: unknown) => redactLogFields(inner, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = redactLogFields(inner, depth + 1);
  return out;
}
