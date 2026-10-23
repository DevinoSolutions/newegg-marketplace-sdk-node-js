/**
 * Redaction of credential-bearing URLs. Newegg answers file-style reports and labels with
 * `ftp://{user}:{password}@ftp03.newegg.com/...` links, so any upstream text that reaches an
 * error, a log line or a tool result must first pass through here. A URL with embedded
 * credentials is a secret - it must never be logged, returned, or placed in an error.
 *
 * Lives under `errors/` because `NeweggError` applies it to every message, `details` payload and
 * `cause`; `reportmgmt/redact.ts` re-exports it for the report code.
 *
 * Linear time, with no length limit on a userinfo, a password or a host: the unbounded runs are
 * measured by scanning forward once for their end (a single character class, so nothing can
 * backtrack), and the work for a run is shared by every candidate that lands inside it. Only the
 * parts of a pattern that are short by definition keep a bound (a scheme is at most 32 characters,
 * a `://` has at most 6 slashes, a host name has at most 9 labels of 63 characters).
 *
 * Known limits: a password containing whitespace (a space ends a URL), a schemeless
 * `user:password@host` on a host other than a Newegg FTP report host, a URL whose delimiters are
 * spelled in some way not listed here, and encodings nested deeper than the decoder's bound are not
 * recognized. This is best-effort pattern matching, not a guarantee: the primary defence is that
 * credentials are never logged or placed in messages in the first place.
 */
import { inspect } from "node:util";

/*
 * Captured once at load: the class-source scan below must not call a `Function.prototype.toString`
 * that the application replaced later (it would run on every scan, and a hostile one could hang).
 */
const functionToString = Function.prototype.toString;
const reflectApply = Reflect.apply;

/** The source text of `fn`, read with the `Function.prototype.toString` captured at load. */
function sourceOf(fn: unknown): string {
  return reflectApply(functionToString, fn, []) as string;
}

/*
 * How the patterns below are applied. Each one is found by a plain scan for a candidate position
 * (a `:` followed by a slash, a `//`, a token boundary) and then checked there, once. A run of
 * characters that a candidate has to measure ends at the first character of a fixed set; the
 * candidates that fall inside the same run share one measurement (see `reservedPasswordHit` and
 * `schemelessHit`) or cannot overlap it at all, so the work is linear in the input.
 */

/**
 * `scheme://` (also `scheme:///`, `scheme:\\` and the JSON-escaped `scheme:\/\/`) followed by the
 * userinfo run up to the LAST `@` of the authority. The authority ends at `/`, `\`, `?`, `#`,
 * whitespace, a quote or an angle bracket, so `https://host/a@b` and `https://host?email=a@b` are
 * left alone, while a password that itself contains `@` is fully covered. There is deliberately no
 * leading word boundary, so `link_ftp://u:p@h` is redacted too. A single slash (`scheme:/u:p@h`)
 * only counts when a `:` follows before the next delimiter, which keeps `file:/etc/x@y` alone.
 */
const USERINFO_END = /[\s/\\?#"'<>]/g;
/** Ends the part before the `:` of a single-slash `scheme:/user:password@host` (also stops at `@`). */
const SINGLE_SLASH_USER_END = /[\s/\\@?#"'<>]/;
/** Most slashes after a scheme colon that still make an authority. */
const MAX_SLASHES = 6;

/** A host at or under `newegg.com`; used only as a lookahead anchor for the looser patterns. */
const NEWEGG_HOST_AT = new RegExp(String.raw`^(?:[a-z0-9-]{1,63}\.){0,8}newegg\.com(?![\w-])`, "i");
/** Longest text {@link NEWEGG_HOST_AT} can match. */
const NEWEGG_HOST_WINDOW = 600;

/**
 * A password holding a literal `/ ? # "`, which ends the pattern above early. When a `newegg.com`
 * host follows, scan to the FIRST `@` that introduces it, so text after the URL is not swallowed.
 * The run ends at whitespace, a single quote or an angle bracket.
 */
const RESERVED_PASSWORD_END = /[\s'<>]/g;

/**
 * Scheme-relative `//user:password@host`. A `user:` part is required, so `//a@b` is untouched.
 * Anchored at the `//`; the caller checks that no word character, `:`, `/`, `\`, `.`, `%` or `-`
 * precedes it.
 */
const SCHEME_RELATIVE_USER_END = /[\s:/\\?#"'<>@]/g;
const BEFORE_SCHEME_RELATIVE = /[\w:/\\.%-]/;

/**
 * Schemeless `user:password@ftp03.newegg.com`. Restricted to Newegg's FTP report hosts and to a
 * token start (the caller only tries it after whitespace, a quote, a bracket, `,;=|` or at the
 * start), so ordinary `label:value@host` text and e-mail addresses keep their meaning. The host
 * labels before `.newegg.com` are captured; the caller requires `ftp` in them.
 */
const SCHEMELESS_USER_END = /[\s:/\\@?#"'<>=,;()[\]{}|]/g;
/** Ends a schemeless password: whitespace, a slash, a quote or an angle bracket. */
const SCHEMELESS_PASSWORD_END = /[\s/\\"'<>]/g;
/** The characters a host name is made of. */
const NOT_HOST_CHAR = /[^\w.-]/g;
/** `.newegg.com` as the end of a host name, not followed by more of the name. */
const NEWEGG_HOST_TAIL = /\.newegg\.com(?![\w-])/gi;
/** The characters a schemeless credential may follow. */
const TOKEN_BOUNDARY = /[\s"'<>(\[{,;=|]/g;

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const SCHEME_LETTER = /[a-z]/i;

/** Cheap pre-check: is there any percent / HTML-entity / fullwidth spelling worth decoding? */
const ENCODED_DELIMITER_HINT = /%(?:3a|2f|5c|40|ef|25)|&(?:#|colon;|sol;|bsol;|commat;)|\uFF20/i;

/** One encoded delimiter: percent, numeric or named HTML entity, or the fullwidth commercial at. */
const ENCODED_DELIMITER =
  /%(?:3a|2f|5c|40)|%ef%bc%a0|&#0*(?:58|47|92|64);|&#x0*(?:3a|2f|5c|40);|&(?:colon|sol|bsol|commat);|\uFF20|%25(?=[0-9a-f]{2})/gi;

const DELIMITER_BY_SPELLING: Readonly<Record<string, string>> = {
  "%3a": ":",
  "&colon;": ":",
  "&#58;": ":",
  "&#x3a;": ":",
  "%2f": "/",
  "&sol;": "/",
  "&#47;": "/",
  "&#x2f;": "/",
  "%5c": "\\",
  "&bsol;": "\\",
  "&#92;": "\\",
  "&#x5c;": "\\",
  "%25": "%",
};

/** Most decoding rounds; each peels one layer of nesting (`%2540`, `%252540`, ...). */
const MAX_DECODE_ROUNDS = 8;

/**
 * Decodes ONLY the URL delimiters (`: / \ @`, in their percent, HTML-entity and fullwidth
 * spellings) so an encoded URL such as `ftp%3A%2F%2Fu%3Ap%40h` becomes visible to the patterns
 * above. Repeats until nothing changes (bounded by {@link MAX_DECODE_ROUNDS}), which unwraps
 * nested percent encoding (`%2540`, `%252540`, ...). Each round is linear.
 */
function decodeDelimiters(text: string): string {
  let current = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const next = current.replace(ENCODED_DELIMITER, (match) => {
      const key = match.toLowerCase().replace(/^(&#x?)0+(?=[0-9a-f])/, "$1");
      // Anything not in the table is a spelling of `@`.
      return DELIMITER_BY_SPELLING[key] ?? "@";
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

interface Hit {
  /** Where the match starts in the original text. */
  readonly start: number;
  /** Where it ends (exclusive). */
  readonly end: number;
  readonly replacement: string;
}

/**
 * One left-to-right pass: `nextCandidate` finds the next place a pattern could start, `tryAt` runs
 * the anchored pattern there. A hit replaces its span and the scan resumes after it (as a global
 * `String.replace` would); a miss moves one position on.
 */
function replacePass(
  text: string,
  nextCandidate: (text: string, from: number) => number,
  tryAt: (text: string, at: number, notBefore: number) => Hit | undefined,
): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const at = nextCandidate(text, from);
    if (at < 0) break;
    const hit = tryAt(text, at, copied);
    if (hit === undefined) {
      from = at + 1;
      continue;
    }
    out += text.slice(copied, hit.start) + hit.replacement;
    copied = hit.end;
    from = Math.max(hit.end, at + 1);
  }
  return out + text.slice(copied);
}

/** The next `:` that is directly followed by `/` or `\`. */
function nextSchemeColon(text: string, from: number): number {
  let at = text.indexOf(":", from);
  while (at >= 0) {
    const next = text.charAt(at + 1);
    if (next === "/" || next === "\\") return at;
    at = text.indexOf(":", at + 1);
  }
  return -1;
}

/**
 * The start of the scheme that ends at the colon `colon`: the first letter of the (at most 32
 * characters long) run of scheme characters before it, never before `notBefore`.
 */
function schemeStart(text: string, colon: number, notBefore: number): number {
  let begin = colon;
  while (begin > notBefore && colon - begin < 32 && SCHEME_CHAR.test(text.charAt(begin - 1))) {
    begin -= 1;
  }
  while (begin < colon && !SCHEME_LETTER.test(text.charAt(begin))) begin += 1;
  return begin < colon ? begin : -1;
}

/** The index of the first match of the global `pattern` at or after `from`, or the text length. */
function runEnd(pattern: RegExp, text: string, from: number): number {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match === null ? text.length : match.index;
}

/** The last `@` in `[begin, end)`, or -1. Bounded by the run, never by the whole text. */
function lastAtIn(text: string, begin: number, end: number): number {
  for (let at = end - 1; at >= begin; at -= 1) {
    if (text.charCodeAt(at) === 64) return at;
  }
  return -1;
}

const isSlash = (char: string): boolean => char === "/" || char === "\\";

/** Does a `:` come before the first delimiter, starting at `from`? */
function colonBeforeDelimiter(text: string, from: number): boolean {
  for (let at = from; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === ":") return true;
    if (SINGLE_SLASH_USER_END.test(char)) return false;
  }
  return false;
}

/** `scheme://user:password@`: userinfo run, up to the last `@` of the authority. */
const schemeHit = (text: string, colon: number, notBefore: number): Hit | undefined => {
  const start = schemeStart(text, colon, notBefore);
  if (start < 0) return undefined;
  let slashes = 0;
  while (slashes <= MAX_SLASHES && isSlash(text.charAt(colon + 1 + slashes))) slashes += 1;
  if (slashes === 0 || slashes > MAX_SLASHES) return undefined;
  const begin = colon + 1 + slashes;
  if (slashes === 1 && !colonBeforeDelimiter(text, begin)) return undefined;
  const at = lastAtIn(text, begin, runEnd(USERINFO_END, text, begin));
  if (at < 0) return undefined;
  const scheme = text.slice(start, colon);
  return { start, end: at + 1, replacement: `${scheme}:${text.slice(colon + 1, begin)}***@` };
};

/**
 * The first `@` of a `scheme://` password run that a `newegg.com` host follows. Every candidate in
 * the same run (`a://a://a://...`) asks the same question, so the answer is measured once and kept
 * for the candidates after it; without that, each one would rescan the rest of the run.
 */
const reservedPasswordHit = (): ((
  text: string,
  colon: number,
  notBefore: number,
) => Hit | undefined) => {
  // The last measurement of a whitespace-free run `[from, end)`: `found` is the first qualifying `@`
  // at or after `from` (or -1 for none). A start inside the run reuses `end`; a start past
  // `found` only rescans forward from itself, so no position is looked at twice.
  let from = -1;
  let end = -1;
  let found = -1;
  return (text, colon, notBefore) => {
    const start = schemeStart(text, colon, notBefore);
    if (start < 0) return undefined;
    let slashes = 0;
    while (slashes < MAX_SLASHES && isSlash(text.charAt(colon + 1 + slashes))) slashes += 1;
    if (slashes < 2) return undefined;
    const begin = colon + 1 + slashes;
    const sameRun = from >= 0 && begin >= from && begin <= end;
    if (!sameRun || (found >= 0 && begin > found)) {
      if (!sameRun) end = runEnd(RESERVED_PASSWORD_END, text, begin);
      from = begin;
      found = -1;
      for (let at = begin; at < end; at += 1) {
        if (
          text.charCodeAt(at) === 64 &&
          NEWEGG_HOST_AT.test(text.slice(at + 1, at + 1 + NEWEGG_HOST_WINDOW))
        ) {
          found = at;
          break;
        }
      }
    }
    if (found < 0) return undefined;
    const scheme = text.slice(start, colon);
    return { start, end: found + 1, replacement: `${scheme}:${text.slice(colon + 1, begin)}***@` };
  };
};

const nextSlashPair = (text: string, from: number): number => text.indexOf("//", from);

const relativeHit = (text: string, at: number): Hit | undefined => {
  if (at > 0 && BEFORE_SCHEME_RELATIVE.test(text.charAt(at - 1))) return undefined;
  const begin = at + 2;
  const userEnd = runEnd(SCHEME_RELATIVE_USER_END, text, begin);
  if (userEnd === begin || text.charAt(userEnd) !== ":") return undefined;
  const lastAt = lastAtIn(text, userEnd + 1, runEnd(USERINFO_END, text, userEnd + 1));
  if (lastAt < 0) return undefined;
  return { start: at, end: lastAt + 1, replacement: "//***@" };
};

/** The next place a token can start: the start of the text, or the position after a boundary. */
function nextTokenStart(text: string, from: number): number {
  if (from === 0) return 0;
  TOKEN_BOUNDARY.lastIndex = from - 1;
  const boundary = TOKEN_BOUNDARY.exec(text);
  return boundary === null || boundary.index + 1 >= text.length ? -1 : boundary.index + 1;
}

/**
 * The host labels before `.newegg.com` when the host name that starts at `from` ends there (the
 * longest such prefix), else `undefined`. A host name is a run of word characters, dots and dashes,
 * and the runs of two different `@` cannot overlap, so this is linear over a whole text.
 */
function neweggHostLabels(text: string, from: number): string | undefined {
  const name = text.slice(from, runEnd(NOT_HOST_CHAR, text, from));
  let labelsEnd = -1;
  NEWEGG_HOST_TAIL.lastIndex = 0;
  for (let tail = NEWEGG_HOST_TAIL.exec(name); tail !== null; tail = NEWEGG_HOST_TAIL.exec(name)) {
    labelsEnd = tail.index;
  }
  return labelsEnd < 0 ? undefined : name.slice(0, labelsEnd);
}

/**
 * `user:password@ftp...newegg.com` at a token start. The password is the longest run that ends in
 * an `@` followed by a Newegg host, so the LAST such `@` of the password run wins. Candidates that
 * share a run (`u:,u:,u:,...`) share its measurement, as in {@link reservedPasswordHit}.
 */
const schemelessHit = (): ((text: string, at: number) => Hit | undefined) => {
  // The last measurement: it answers every password start in `[from, end]`.
  let from = -1;
  let end = -1;
  let found = -1;
  let labels = "";
  return (text, at) => {
    const userEnd = runEnd(SCHEMELESS_USER_END, text, at);
    if (userEnd === at || text.charAt(userEnd) !== ":") return undefined;
    const begin = userEnd + 1;
    if (from < 0 || begin < from || begin > end) {
      from = begin;
      end = runEnd(SCHEMELESS_PASSWORD_END, text, begin);
      found = -1;
      for (let candidate = end - 1; candidate >= begin; candidate -= 1) {
        if (text.charCodeAt(candidate) !== 64) continue;
        const hostLabels = neweggHostLabels(text, candidate + 1);
        if (hostLabels === undefined) continue;
        found = candidate;
        labels = hostLabels;
        break;
      }
    }
    // Only FTP hosts qualify.
    if (found < begin || !/ftp/i.test(labels)) return undefined;
    return { start: at, end: found + 1, replacement: "***@" };
  };
};

function redactVisible(text: string): string {
  // Every pattern ends in a literal `@`, so text without one is returned without scanning it.
  if (!text.includes("@")) return text;
  let result = replacePass(text, nextSchemeColon, schemeHit);
  result = replacePass(result, nextSchemeColon, reservedPasswordHit());
  result = replacePass(result, nextSlashPair, relativeHit);
  return replacePass(result, nextTokenStart, schemelessHit());
}

/**
 * Replaces the `user:password@` part of a URL inside `text` with `***@` for the spellings listed here:
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

/** How {@link sanitize} cleans a value: its strings, and whether a credential-named key is masked. */
interface SanitizeMode {
  readonly text: (text: string) => string;
  readonly maskKeys: boolean;
}

function sanitize(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  mode: SanitizeMode,
): unknown {
  if (typeof value === "string") return mode.text(value);
  if (typeof value !== "object" || value === null) return value;
  const isArray = Array.isArray(value);
  // Dates, Maps, class instances etc. are not JSON data: pass them through untouched.
  if (!isArray && !isPlainObject(value)) return value;
  if (seen.has(value) || depth >= MAX_DEPTH) return "[Circular]";
  seen.add(value);
  try {
    if (isArray) return value.map((inner: unknown) => sanitize(inner, seen, depth + 1, mode));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        mode.maskKeys && typeof inner === "string" && inner !== "" && isCredentialName(key)
          ? "***"
          : sanitize(inner, seen, depth + 1, mode);
    }
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
  return sanitize(value, new WeakSet(), 0, { text: redactUrlCredentials, maskKeys: false });
}

/**
 * {@link sanitizeRaw} plus the credential-name redaction of {@link redactCredentialText}, and a
 * string value kept under a credential name (`SecretKey`, `token`, ...) is masked. Used for
 * `NeweggError.details`.
 */
export function sanitizeDetails(value: unknown): unknown {
  return sanitize(value, new WeakSet(), 0, { text: redactCredentialText, maskKeys: true });
}

/**
 * Names (as words, joined by an optional `-` or `_`) of values that are credentials or account ids.
 * One list drives the text pattern, the header / query-parameter / property-key test and, by
 * copy, the MCP log redaction (`packages/mcp-server/src/tools/log-redact.ts`; a test asserts that
 * both cover the same names).
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

/** Credential names that only make sense as a header / property name, not in running text. */
const STRUCTURAL_ONLY = ["cookie", "setcookie"];

const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  ...CREDENTIAL_WORDS.map((words) => words.join("")),
  ...STRUCTURAL_ONLY,
]);

/** Whether a header, query-parameter or property name holds a credential. */
function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAMES.has(name.toLowerCase().replace(/[-_\s]/g, ""));
}

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
 * `name=value`, `"name":"value"` and `{ name: 'value' }` for any credential name, and `name: value`
 * for a header-like one; the value runs up to the next delimiter. A `Bearer` / `Basic` / `Digest`
 * scheme word is part of the value. No nested quantifiers: linear. Groups 1 and 2 are a header-like
 * name and its separator, 3 and 4 a generic name and its separator. A value may be quoted with
 * `'`, `"` or a backtick (`\x60`).
 */
const CREDENTIAL_TEXT = new RegExp(
  String.raw`(?<![\w.-])(?:(${HEADER_LIKE_PATTERN})(["']?\s*[:=]\s*["'\x60]?)|(${GENERIC_PATTERN})(["']?\s*=\s*["'\x60]?|["']\s*:\s*["'\x60]?|\s*:\s*["'\x60]))((?:(?:bearer|basic|digest)\s+)?[^&\s#"'\x60<>,;]+)`,
  "gi",
);

/**
 * An object-literal entry (`util.inspect` output, JSON): after `{` or `,` a credential key whose
 * value is a number, `true`, `false`, `null` or `undefined` (the quoted forms are in
 * {@link CREDENTIAL_TEXT}). Prose has no `{` / `,` in front of the name and carries no such value.
 * The prefix is consumed rather than looked behind, so the scan stays linear.
 */
const OBJECT_LITERAL_TEXT = new RegExp(
  String.raw`([{,]\s*["']?)(${ANY_NAME_PATTERN})(["']?\s*:\s*)(-?\d[^\s,;&#"'\x60<>}\])]*|true|false|null|undefined)(?![\w.-])`,
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

/** Masks a cookie value, keeping its quotes (`"cookie":"a=b"` -> `"cookie":"***"`). */
function maskCookieValue(value: string): string {
  const quote = value.startsWith('"') || value.startsWith("'") ? value.charAt(0) : "";
  return quote !== "" && value.length > 1 && value.endsWith(quote)
    ? `${quote}***${quote}`
    : `${quote}***`;
}

const maskCredentialText = (text: string): string =>
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
      ) => `${headerName ?? name ?? ""}${headerSeparator ?? separator ?? ""}***`,
    )
    .replace(
      OBJECT_LITERAL_TEXT,
      (_match, prefix: string, name: string, separator: string) =>
        `${prefix}${name}${separator}***`,
    );

/**
 * {@link redactUrlCredentials} plus the values of credential-bearing parameters, header lines and
 * cookie lines (`sellerid=...`, `Authorization: Bearer ...`, `"SecretKey":"..."`, `Cookie: ...`,
 * percent-encoded spellings included). Prose that merely pairs a credential word with a colon is
 * left alone. Applied to a cause and to every `NeweggError` message and `details` string.
 */
export function redactCredentialText(text: string): string {
  const base = redactUrlCredentials(text);
  const direct = maskCredentialText(base);
  if (!base.includes("%")) return direct;
  const decoded = decodePercent(base);
  if (decoded === base) return direct;
  const fromDecoded = maskCredentialText(decoded);
  return fromDecoded !== decoded ? fromDecoded : direct;
}

/** The entries of `headers` with every credential header masked and every other value redacted. */
function redactedHeaderEntries(headers: Headers): {
  entries: Array<[string, string]>;
  changed: boolean;
} {
  let changed = false;
  const entries: Array<[string, string]> = [];
  for (const [name, item] of headers) {
    const cleaned = isCredentialName(name) ? "***" : redactCredentialText(item);
    if (cleaned !== item) changed = true;
    entries.push([name, cleaned]);
  }
  return { entries, changed };
}

const MAX_CAUSE_DEPTH = 12;
/** Most objects visited per cause, so a huge or hostile object graph cannot make the scan slow. */
const MAX_CAUSE_NODES = 2000;

interface CauseWalk {
  nodes: number;
}

/**
 * The own properties of `value` whose cleaned value differs from the current one, as data
 * descriptors. Accessors are read once (a getter that throws is left alone); this is what covers
 * the `stack` of a V8 error, which is an own accessor that embeds the message text.
 */
function changedOwnProperties(
  value: object,
  path: readonly object[],
  walk: CauseWalk,
  skip?: (key: string | symbol) => boolean,
): Map<string | symbol, PropertyDescriptor> {
  const changed = new Map<string | symbol, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(value)) {
    if (skip?.(key) === true) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    let current: unknown;
    if ("value" in descriptor) {
      current = descriptor.value;
    } else if (descriptor.get !== undefined) {
      try {
        current = descriptor.get.call(value);
      } catch {
        continue;
      }
    } else {
      continue;
    }
    const cleaned =
      typeof current === "string" &&
      current !== "" &&
      typeof key === "string" &&
      isCredentialName(key)
        ? "***"
        : cleanCauseValue(current, path, walk);
    if (cleaned !== current) {
      changed.set(key, {
        value: cleaned,
        writable: true,
        enumerable: descriptor.enumerable === true,
        configurable: true,
      });
    }
  }
  return changed;
}

/** A copy of `value` (same prototype, same own properties) with `changed` applied over them. */
function cloneWith(value: object, changed: Map<string | symbol, PropertyDescriptor>): object {
  const clone = cloneBase(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = changed.get(key) ?? Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    try {
      Object.defineProperty(clone, key, descriptor);
    } catch {
      // A property the fresh base already has and cannot redefine (a boxed string's indices).
    }
  }
  return clone;
}

/** An empty object of the same kind: Dates, RegExps and boxed primitives keep their internal value. */
function cloneBase(value: object): object {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return Object(value.valueOf()) as object;
  }
  return Object.create(Object.getPrototypeOf(value) as object | null) as object;
}

/** The `util.inspect` text of an object. No string clipping: a clipped `ftp://u:pass...` would lose its `@`. */
function textSummary(value: object, customInspect = false): string {
  return inspect(value, {
    depth: 3,
    breakLength: Infinity,
    maxStringLength: null,
    customInspect,
  });
}

/** {@link textSummary} with URL credentials removed. Used where no safe copy exists. */
function redactedSummary(value: object): string {
  try {
    return redactCredentialText(textSummary(value));
  } catch {
    return "[Unreadable]";
  }
}

/** Built-in kinds whose internal value {@link cloneBase} carries over, so their natives are fine. */
const COPIED_BUILTIN_PROTOTYPES: ReadonlySet<object> = new Set<object>([
  Date.prototype,
  RegExp.prototype,
  Number.prototype,
  String.prototype,
  Boolean.prototype,
  Error.prototype,
]);

/** A private-state pattern outside the class body: `store.get(this)` on a module-level WeakMap. */
const WEAKMAP_PRIVATE = /\.\s*(?:get|has)\s*\(\s*this\s*\)/;

/**
 * Whether a same-prototype copy of an object of this kind could break: a prototype accessor,
 * `toJSON` or `[util.inspect.custom]` that is native code (internal slots) or reads a `#private`
 * field (its source text names one) throws on a copy made by `Object.create(prototype)`. A hook
 * can reach such state through another method, so when the chain has a hook the source of its
 * classes is scanned for `#` and WeakMap-style private state too. Only source text is read, so no
 * getter or hook of the object ever runs. It is conservative (a `#` inside a string or comment also
 * counts), and an object it rejects becomes a text summary. A class with no hook whose plain
 * methods alone touch `#private` state is still copied.
 */
function copyNeedsInternalState(value: object): boolean {
  try {
    let hasHook = false;
    const classSources: string[] = [];
    let proto = Object.getPrototypeOf(value) as object | null;
    while (proto !== null && proto !== Object.prototype && !COPIED_BUILTIN_PROTOTYPES.has(proto)) {
      for (const key of Reflect.ownKeys(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor === undefined) continue;
        const isHook = key === inspect.custom || key === "toJSON";
        if (isHook && typeof descriptor.value === "function") hasHook = true;
        const hooks = isHook ? [descriptor.value] : [];
        for (const fn of [descriptor.get, descriptor.set, ...hooks] as unknown[]) {
          if (typeof fn !== "function") continue;
          const source = sourceOf(fn);
          const native = source.includes("[native code]") && fn !== descriptor.value;
          if (source.includes("#") || WEAKMAP_PRIVATE.test(source) || native) return true;
        }
        if (key === "constructor" && typeof descriptor.value === "function") {
          classSources.push(sourceOf(descriptor.value));
        }
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    return hasHook && classSources.some((src) => src.includes("#") || WEAKMAP_PRIVATE.test(src));
  } catch {
    return true;
  }
}

/** Objects whose data lives in internal slots, not own properties: only their text form is read. */
function isOpaqueRequestOrResponse(value: object): value is Request | Response {
  return (
    (typeof Response === "function" && value instanceof Response) ||
    (typeof Request === "function" && value instanceof Request)
  );
}

/** `target` with the own properties of `source` copied onto it, `changed` ones in their redacted form. */
function withOwnProperties<T extends object>(
  target: T,
  source: object,
  changed: Map<string | symbol, PropertyDescriptor>,
): T {
  for (const key of Reflect.ownKeys(source)) {
    // Never overwrite the fresh object's internal slots with the source's.
    if (SYMBOL_KEYS(key)) continue;
    const descriptor = changed.get(key) ?? Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) continue;
    try {
      Object.defineProperty(target, key, descriptor);
    } catch {
      // A property the fresh object has and cannot redefine.
    }
  }
  return target;
}

/**
 * A callable keeps its identity unless an own property (a static member, an attached `url`) is
 * changed; then a forwarding wrapper with the same name, length, prototype and (redacted)
 * properties replaces it. `prototype` is not walked (it points back at the function); the wrapper
 * gets a fresh one that inherits from the original's, so `new wrapper() instanceof Original` holds.
 */
const FUNCTION_SKIP = (key: string | symbol): boolean => key === "prototype";

/**
 * Platform objects (Response, Request, Headers, URLSearchParams) keep their internals under symbol
 * keys on some runtimes (undici on Node 22): cyclic streams, controllers, lists. Those are not data,
 * and walking them turns a clean object into a copy that no longer works. Only string-keyed own
 * properties, the ones a caller attaches (`response.link`), are walked and copied. A secret under a
 * SYMBOL key on these four types is therefore not redacted (documented, low risk).
 */
const SYMBOL_KEYS = (key: string | symbol): boolean => typeof key === "symbol";

function cloneFunction(
  fn: (...args: unknown[]) => unknown,
  changed: Map<string | symbol, PropertyDescriptor>,
): object {
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    return new.target === undefined
      ? (Reflect.apply(fn, this, args) as unknown)
      : (Reflect.construct(fn, args, new.target) as unknown);
  };
  Object.setPrototypeOf(wrapper, Object.getPrototypeOf(fn) as object | null);
  // A fresh prototype object that inherits from the original's keeps `new wrapper() instanceof
  // Original` true without pointing back (through `constructor`) at the original and its secrets.
  const original: unknown = fn.prototype;
  if (typeof original === "object" && original !== null) {
    const fresh = Object.create(original) as object;
    Object.defineProperty(fresh, "constructor", {
      value: wrapper,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(wrapper, "prototype", { value: fresh, writable: true });
  }
  for (const key of Reflect.ownKeys(fn)) {
    if (FUNCTION_SKIP(key)) continue;
    const descriptor = forwardPrivateAccess(
      fn,
      key,
      changed.get(key) ?? Object.getOwnPropertyDescriptor(fn, key),
      changed.has(key),
    );
    if (descriptor === undefined) continue;
    try {
      Object.defineProperty(wrapper, key, descriptor);
    } catch {
      // A property the wrapper has and cannot redefine.
    }
  }
  return wrapper;
}

/**
 * A static method or accessor that reads `this.#x` throws when `this` is the wrapper, so (judging by
 * its source text, as in {@link copyNeedsInternalState}) it is bound to, or forwarded to, the
 * original. Redacted data properties are left as they are.
 */
function forwardPrivateAccess(
  fn: object,
  key: string | symbol,
  descriptor: PropertyDescriptor | undefined,
  isChanged: boolean,
): PropertyDescriptor | undefined {
  if (descriptor === undefined || isChanged) return descriptor;
  const usesPrivate = (f: unknown): boolean => typeof f === "function" && sourceOf(f).includes("#");
  if (typeof descriptor.value === "function" && usesPrivate(descriptor.value)) {
    return { ...descriptor, value: (descriptor.value as () => unknown).bind(fn) };
  }
  if (usesPrivate(descriptor.get) || usesPrivate(descriptor.set)) {
    return {
      get: () => Reflect.get(fn, key, fn) as unknown,
      set: (next: unknown) => void Reflect.set(fn, key, next, fn),
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
    };
  }
  return descriptor;
}

/** A Request or Response as text, with credential headers masked and every string redacted. */
function redactedRequestSummary(value: Request | Response): string {
  const { entries } = redactedHeaderEntries(value.headers);
  const summary: Record<string, unknown> = { headers: Object.fromEntries(entries) };
  if (value instanceof Request) summary.method = value.method;
  else summary.status = value.status;
  summary.url = value.url;
  return redactCredentialText(
    inspect(summary, {
      depth: 3,
      breakLength: Infinity,
      maxStringLength: null,
      customInspect: false,
    }),
  );
}

function cleanCauseValue(value: unknown, path: readonly object[], walk: CauseWalk): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (typeof value === "symbol") {
    const description = value.description;
    if (description === undefined) return value;
    const cleaned = redactCredentialText(description);
    return cleaned === description ? value : Symbol(cleaned);
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (path.includes(value)) return "[Circular]";
  walk.nodes += 1;
  if (path.length >= MAX_CAUSE_DEPTH || walk.nodes > MAX_CAUSE_NODES) return "[Truncated]";
  const next = [...path, value];
  try {
    if (typeof value === "function") {
      const changedProps = changedOwnProperties(value, next, walk, FUNCTION_SKIP);
      return changedProps.size === 0
        ? value
        : cloneFunction(value as (...args: unknown[]) => unknown, changedProps);
    }
    if (Array.isArray(value)) {
      const items = (value as unknown[]).map((item) => cleanCauseValue(item, next, walk));
      return items.some((item, index) => item !== (value as unknown[])[index]) ? items : value;
    }
    if (value instanceof URL) {
      const cleaned = redactCredentialText(value.href);
      return cleaned === value.href ? value : cleaned;
    }
    if (value instanceof RegExp) {
      // A mask would not be a valid pattern, so a RegExp holding a secret becomes a marker string.
      // Escapes are removed first, so `ftp03\.host` is read as a host name.
      const unescaped = value.source.replace(/\\(.)/g, "$1");
      if (redactCredentialText(unescaped) !== unescaped) return "[Redacted RegExp]";
    }
    if (value instanceof Map) {
      let changed = false;
      const entries: Array<[unknown, unknown]> = [];
      for (const [key, item] of value as Map<unknown, unknown>) {
        const cleanedKey = cleanCauseValue(key, next, walk);
        const cleanedItem = cleanCauseValue(item, next, walk);
        if (cleanedKey !== key || cleanedItem !== item) changed = true;
        entries.push([cleanedKey, cleanedItem]);
      }
      return changed ? new Map(entries) : value;
    }
    if (value instanceof Set) {
      const members = [...(value as Set<unknown>)];
      const cleaned = members.map((item) => cleanCauseValue(item, next, walk));
      return cleaned.some((item, index) => item !== members[index]) ? new Set(cleaned) : value;
    }
    if (value instanceof Uint8Array) {
      // Buffers print as hex bytes, which still spell the URL.
      const text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("latin1");
      const cleaned = redactCredentialText(text);
      return cleaned === text ? value : Buffer.from(cleaned, "latin1");
    }
    // Typed arrays and DataViews hold bytes, not properties.
    if (ArrayBuffer.isView(value)) return value;
    // Their entries live in internal slots, so they are rebuilt from the (redacted) entries.
    if (value instanceof URLSearchParams) {
      let changed = false;
      const pairs: Array<[string, string]> = [];
      for (const [name, item] of value) {
        const cleanedName = redactCredentialText(name);
        const cleaned = isCredentialName(name) && item !== "" ? "***" : redactCredentialText(item);
        if (cleanedName !== name || cleaned !== item) changed = true;
        pairs.push([cleanedName, cleaned]);
      }
      const props = changedOwnProperties(value, next, walk, SYMBOL_KEYS);
      if (!changed && props.size === 0) return value;
      return withOwnProperties(new URLSearchParams(pairs), value, props);
    }
    if (value instanceof Headers) {
      const { entries, changed } = redactedHeaderEntries(value);
      const rebuilt = new Headers();
      for (const [name, item] of entries) rebuilt.append(name, item);
      const props = changedOwnProperties(value, next, walk, SYMBOL_KEYS);
      if (!changed && props.size === 0) return value;
      return withOwnProperties(rebuilt, value, props);
    }
    // A Response or Request keeps its status text, URL and headers in internal slots; a copy made
    // from its prototype would throw on first use. Read the text form instead.
    if (isOpaqueRequestOrResponse(value)) {
      // A platform object: its own `[util.inspect.custom]` is what prints status text and URL.
      const text = textSummary(value, true);
      const redacted = redactCredentialText(text);
      const headersChanged = redactedHeaderEntries(value.headers).changed;
      // An own property (`response.link`) holding a secret also forces the text form.
      const props = changedOwnProperties(value, next, walk, SYMBOL_KEYS);
      if (redacted === text && !headersChanged && props.size === 0) return value;
      return headersChanged ? redactedRequestSummary(value) : redacted;
    }
    if (value instanceof String) {
      // The boxed text itself is what util.inspect prints, so it is redacted too.
      const text = value.valueOf();
      const cleanedText = redactCredentialText(text);
      const changedProps = changedOwnProperties(value, next, walk);
      for (const key of [...changedProps.keys()]) {
        if (key === "length" || (typeof key === "string" && /^\d+$/.test(key))) {
          changedProps.delete(key);
        }
      }
      if (cleanedText === text && changedProps.size === 0) return value;
      const boxed = Object(cleanedText) as object;
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length" || (typeof key === "string" && /^\d+$/.test(key))) continue;
        const descriptor = changedProps.get(key) ?? Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined) Object.defineProperty(boxed, key, descriptor);
      }
      return boxed;
    }
    // Every other object (errors, plain objects, class instances, Dates, RegExps, boxed primitives):
    // every own property, accessors included. An object
    // keeps its identity unless a redaction changes one of its properties; then a same-prototype
    // copy replaces it and the original is never mutated.
    const changed = changedOwnProperties(value, next, walk);
    if (changed.size === 0) return value;
    // A copy that could not work (an object with `#private` fields) becomes a text summary.
    return copyNeedsInternalState(value) ? redactedSummary(value) : cloneWith(value, changed);
  } catch {
    return "[Unreadable]";
  }
}

/**
 * Returns `cause` with URL credentials removed from every string it can reach: the message and the
 * stack of an error (even when `stack` is an accessor), its own string properties and nested
 * `cause`, `AggregateError.errors`, arrays, plain objects, class instances, `Map` / `Set` entries,
 * buffers, a `URL` (reduced to a redacted string), functions (their own properties), `URLSearchParams`
 * and `Headers` (rebuilt from redacted entries), and a `Response` or `Request` (reduced to a redacted
 * text summary, as is any object whose copy would not work, for example one with `#private` fields). So `console.log(error)` / `util.inspect`
 * (which print the whole cause chain) cannot leak them. A value with nothing to redact is returned
 * as-is (same identity); otherwise a same-prototype copy is returned and the original is never
 * mutated. Depth and node count are bounded, and a value that cannot be read becomes
 * `"[Unreadable]"` rather than throwing.
 *
 * Credentials: strings (and `Symbol` descriptions, `RegExp` sources) lose the value of a credential
 * name (`sellerid=`, `token=`, `Authorization: Bearer ...`, `"SecretKey":"..."`, percent-encoded
 * spellings included). `Headers`, `Request` and `Response` mask credential headers, a
 * `URLSearchParams` entry or a string-valued own property whose NAME is a credential name is masked
 * whatever its value looks like. Hooks: a caller's prototype getters and `[util.inspect.custom]` /
 * `toJSON` are never run (only their source text is read); the exception is a `Response` /
 * `Request` subclass with its own `inspect.custom`, which does run when the text summary is made.
 * A redacted function is a wrapper: `new wrapper() instanceof Original` holds and
 * `wrapper.prototype.constructor` is the wrapper, so the original's secrets are not reachable via
 * inspect, logs, JSON or `wrapper.prototype.constructor`. They remain reachable programmatically
 * through `Object.getPrototypeOf(wrapper.prototype).constructor`, because `instanceof` needs that
 * link. Bound static methods report the name `bound x`.
 *
 * Out of contract (the SDK never attaches these to a cause, and each needs the object's own code to
 * cooperate): a secret held only in `toJSON()` output or returned by a custom
 * `[util.inspect.custom]`, a `Proxy` that hides its target, a `Promise`, `Map` iterator or
 * `FormData` (contents live in internal slots), string keys of Maps that are URLs, extra own
 * properties on arrays, typed arrays, `Buffer` and `URL`, credentials in string or `Symbol`
 * property KEYS, a boxed `Symbol`, and a getter that throws under `util.inspect({ getters: true })`.
 * Own accessors are read once. `NeweggError`'s own `message` and `details` get the same
 * credential-name redaction ({@link redactCredentialText}, {@link sanitizeDetails}).
 */
export function sanitizeCause(cause: unknown): unknown {
  return cleanCauseValue(cause, [], { nodes: 0 });
}
