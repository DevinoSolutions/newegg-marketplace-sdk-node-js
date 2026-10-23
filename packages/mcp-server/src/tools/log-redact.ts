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
 * Which credential names are masked after a bare `name: value` (a colon and nothing else). A
 * multi-word name (`SellerID`, `SecretKey`, `Access-Token`, `client_secret`, `X-Api-Key`, ...) and
 * `Authorization` are header-like, so `SellerID: A006 is not authorized` and
 * `Refresh-Token: ...` are masked. A single generic word (`token`, `password`, `passwd`,
 * `secret`) is ordinary prose after a colon (`Unexpected token: } in JSON`, `password: must be at
 * least 8 characters`), so it needs `=`, a quoted name (`"token": "..."`), a quoted value
 * (`{ token: '...' }`) or an object-literal key position (below). A header-style line such as
 * `Password: hunter2` cannot be told from `Password: must be at least 8 characters` and is NOT
 * masked: a documented limit.
 */
const isHeaderLike = (words: readonly string[]): boolean =>
  words.length > 1 || words[0] === "authorization";

/** The alternation of `list` as name patterns, longest first so `x-auth-token` wins over `x-auth`. */
const namePattern = (list: readonly (readonly string[])[]): string =>
  [...list]
    .sort((a, b) => b.join("").length - a.join("").length)
    .map((words) => words.join("[-_]?"))
    .join("|");

const HEADER_LIKE_PATTERN = namePattern(CREDENTIAL_WORDS.filter(isHeaderLike));
const GENERIC_PATTERN = namePattern(CREDENTIAL_WORDS.filter((words) => !isHeaderLike(words)));
const ANY_NAME_PATTERN = namePattern(CREDENTIAL_WORDS);

/**
 * A quoted value: `"..."`, `'...'` or a backtick (`\x60`) string in which a backslash escapes the
 * character after it, so `"a\"b"` is one value. It ends at its closing quote or, when there is none,
 * at the end of the line. Only the quote that opened it closes it.
 */
const QUOTED_VALUE = String.raw`"(?:[^"\\\r\n]|\\.)*"?|'(?:[^'\\\r\n]|\\.)*'?|\x60(?:[^\x60\\\r\n]|\\.)*\x60?`;

/** An unquoted value: up to the next delimiter, a backslash escaping the character after it. */
const UNQUOTED_VALUE = String.raw`(?:(?:bearer|basic|digest)\s+)?(?:[^&\s#"'\x60<>,;\\]|\\.?)+`;

/**
 * `name=value`, `"name":"value"` and `{ name: 'value' }` for any credential name, and `name: value`
 * for a header-like one; a value is {@link QUOTED_VALUE} or {@link UNQUOTED_VALUE}. A `Bearer` /
 * `Basic` / `Digest` scheme word is part of an unquoted value. Every quantifier is over a character
 * class or an escape pair and nothing follows the value, so the scan is linear. Groups 1 to 3 are a
 * header-like name, its separator and its value; 4 is a generic name, then 5 and 6 a `=` (or
 * quoted-name colon) separator and value, 7 and 8 a bare colon and a value that must be quoted.
 */
const CREDENTIAL_TEXT = new RegExp(
  String.raw`(?<![\w.-])(?:(${HEADER_LIKE_PATTERN})(["']?\s*[:=]\s*)(${QUOTED_VALUE}|${UNQUOTED_VALUE})|(${GENERIC_PATTERN})(?:(["']?\s*=\s*|["']\s*:\s*)(${QUOTED_VALUE}|${UNQUOTED_VALUE})|(\s*:\s*)(${QUOTED_VALUE})))`,
  "gi",
);

/**
 * An object-literal entry (`util.inspect` output, JSON): after `{` or `,` a credential key whose
 * value is a number, `true`, `false`, `null` or `undefined` and is followed by `,`, `}`, `]` or the
 * end of the text (the quoted forms are in {@link CREDENTIAL_TEXT}). Prose such as `Failed, token: 3
 * attempts left` has no such ending and is left alone; `{ a: 1, password: 12345 }` is masked. The
 * prefix is consumed rather than looked behind, so the scan stays linear.
 */
const OBJECT_LITERAL_TEXT = new RegExp(
  String.raw`([{,]\s*["']?)(${ANY_NAME_PATTERN})(["']?\s*:\s*)(-?\d[^\s,;&#"'\x60<>}\])]*|true|false|null|undefined)(?=\s*(?:[,}\]]|$))`,
  "gi",
);

/**
 * A `Cookie` / `Set-Cookie` line. After a colon the value runs to the end of the line (a cookie holds
 * `;` and spaces), after `=` to the next delimiter; a quoted value ends at its closing quote, and a
 * backslash escapes the character after it (`"a=1; b=\"2\""`).
 */
const COOKIE_TEXT =
  /(?<![\w.-])(set[-_]?cookie|cookie)(?:(["']?\s*:\s*)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\r\n]*)|(["']?\s*=\s*)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^&\s#"'<>]+))/gi;

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

/** Masks a value, keeping its quotes (`"cookie":"a=b"` -> `"cookie":"[redacted]"`). */
function maskValue(value: string): string {
  const quote = /^["'`]/.test(value) ? value.charAt(0) : "";
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
      ) => `${name}${colon ?? equals ?? ""}${maskValue(colonValue ?? equalsValue ?? "")}`,
    )
    .replace(
      CREDENTIAL_TEXT,
      (
        _match,
        headerName: string | undefined,
        headerSeparator: string | undefined,
        headerValue: string | undefined,
        name: string | undefined,
        equalsSeparator: string | undefined,
        equalsValue: string | undefined,
        colonSeparator: string | undefined,
        colonValue: string | undefined,
      ) =>
        `${headerName ?? name ?? ""}${headerSeparator ?? equalsSeparator ?? colonSeparator ?? ""}${maskValue(headerValue ?? equalsValue ?? colonValue ?? "")}`,
    )
    .replace(
      OBJECT_LITERAL_TEXT,
      (_match, prefix: string, name: string, separator: string) =>
        `${prefix}${name}${separator}${REDACTED}`,
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
