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
 * `user:password@host` on a host other than a Newegg FTP report host, a URL whose delimiters are
 * spelled in some way not listed here, and encodings nested deeper than the decoder's bound are not
 * recognized. This is best-effort pattern matching, not a guarantee: the primary defence is that
 * credentials are never logged or placed in messages in the first place.
 */

/*
 * How the patterns below are applied. Every regular expression is anchored with `^` and run on a
 * short slice that starts at a candidate position found by a plain scan (a `:` followed by a
 * slash, a `//`, a token boundary). A pattern therefore has exactly one place to start per
 * candidate and never restarts inside a long run of text, so the work is linear in the input: the
 * candidates are visited once, in order, and each costs at most its slice length.
 */

/**
 * `scheme://` (also `scheme:///`, `scheme:\\` and the JSON-escaped `scheme:\/\/`) followed by the
 * userinfo run up to the LAST `@` of the authority. The authority ends at `/`, `\`, `?`, `#`,
 * whitespace or a quote, so `https://host/a@b` and `https://host?email=a@b` are left alone, while
 * a password that itself contains `@` is fully covered. There is deliberately no leading word
 * boundary, so `link_ftp://u:p@h` is redacted too. Anchored at the scheme start.
 */
const URL_WITH_CREDENTIALS =
  /^([a-z][a-z0-9+.-]{0,31}):([\\/]{2,6}|[\\/](?=[^\s/\\@?#"'<>]{0,256}:))[^\s/\\?#"'<>]{0,2048}@/i;
/** Longest text {@link URL_WITH_CREDENTIALS} can match. */
const URL_WITH_CREDENTIALS_WINDOW = 2200;

/** A host at or under `newegg.com`; used only as a lookahead anchor for the looser patterns. */
const NEWEGG_HOST = String.raw`(?:[a-z0-9-]{1,63}\.){0,8}newegg\.com(?![\w-])`;

/**
 * A password holding a literal `/ ? # "`, which ends the pattern above early. When a `newegg.com`
 * host follows, scan lazily (at most 256 characters) to the FIRST `@` that introduces it, so text
 * after the URL is not swallowed. Anchored at the scheme start.
 */
const URL_WITH_RESERVED_CHARS_IN_PASSWORD = new RegExp(
  String.raw`^([a-z][a-z0-9+.-]{0,31}):([\\/]{2,6})[^\s'<>]{0,256}?@(?=${NEWEGG_HOST})`,
  "i",
);
const URL_WITH_RESERVED_CHARS_WINDOW = 1000;

/**
 * Scheme-relative `//user:password@host`. A `user:` part is required, so `//a@b` is untouched.
 * Anchored at the `//`; the caller checks that no word character, `:`, `/`, `\`, `.`, `%` or `-`
 * precedes it.
 */
const SCHEME_RELATIVE_CREDENTIALS = /^(\/\/)[^\s:/\\?#"'<>@]{1,256}:[^\s/\\?#"'<>]{0,2048}@/;
const SCHEME_RELATIVE_WINDOW = 2400;
const BEFORE_SCHEME_RELATIVE = /[\w:/\\.%-]/;

/**
 * Schemeless `user:password@ftp03.newegg.com`. Restricted to Newegg's FTP report hosts and to a
 * token start (the caller only tries it after whitespace, a quote, a bracket, `,;=|` or at the
 * start), so ordinary `label:value@host` text and e-mail addresses keep their meaning. The
 * lookahead captures the host labels before `.newegg.com`; the caller requires `ftp` in them.
 */
const SCHEMELESS_CREDENTIALS = new RegExp(
  String.raw`^[^\s:/\\@?#"'<>=,;()\[\]{}|]{1,128}:[^\s/\\"'<>]{0,256}@(?=([\w.-]{0,255})\.newegg\.com(?![\w-]))`,
  "i",
);
const SCHEMELESS_WINDOW = 700;
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

const schemeHit =
  (pattern: RegExp, window: number) =>
  (text: string, colon: number, notBefore: number): Hit | undefined => {
    const start = schemeStart(text, colon, notBefore);
    if (start < 0) return undefined;
    const match = pattern.exec(text.slice(start, start + window));
    if (match === null) return undefined;
    return { start, end: start + match[0].length, replacement: `${match[1]}:${match[2]}***@` };
  };

const nextSlashPair = (text: string, from: number): number => text.indexOf("//", from);

const relativeHit = (text: string, at: number): Hit | undefined => {
  if (at > 0 && BEFORE_SCHEME_RELATIVE.test(text.charAt(at - 1))) return undefined;
  const match = SCHEME_RELATIVE_CREDENTIALS.exec(text.slice(at, at + SCHEME_RELATIVE_WINDOW));
  if (match === null) return undefined;
  return { start: at, end: at + match[0].length, replacement: "//***@" };
};

/** The next place a token can start: the start of the text, or the position after a boundary. */
function nextTokenStart(text: string, from: number): number {
  if (from === 0) return 0;
  TOKEN_BOUNDARY.lastIndex = from - 1;
  const boundary = TOKEN_BOUNDARY.exec(text);
  return boundary === null || boundary.index + 1 >= text.length ? -1 : boundary.index + 1;
}

const schemelessHit = (text: string, at: number): Hit | undefined => {
  const match = SCHEMELESS_CREDENTIALS.exec(text.slice(at, at + SCHEMELESS_WINDOW));
  // The lookahead captured the host labels before `.newegg.com`; only FTP hosts qualify.
  if (match === null || !/ftp/i.test(match[1] ?? "")) return undefined;
  return { start: at, end: at + match[0].length, replacement: "***@" };
};

function redactVisible(text: string): string {
  // Every pattern ends in a literal `@`, so text without one is returned without scanning it.
  if (!text.includes("@")) return text;
  let result = replacePass(
    text,
    nextSchemeColon,
    schemeHit(URL_WITH_CREDENTIALS, URL_WITH_CREDENTIALS_WINDOW),
  );
  result = replacePass(
    result,
    nextSchemeColon,
    schemeHit(URL_WITH_RESERVED_CHARS_IN_PASSWORD, URL_WITH_RESERVED_CHARS_WINDOW),
  );
  result = replacePass(result, nextSlashPair, relativeHit);
  return replacePass(result, nextTokenStart, schemelessHit);
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
): Map<string | symbol, PropertyDescriptor> {
  const changed = new Map<string | symbol, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(value)) {
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
    const cleaned = cleanCauseValue(current, path, walk);
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

function cleanCauseValue(value: unknown, path: readonly object[], walk: CauseWalk): unknown {
  if (typeof value === "string") return redactUrlCredentials(value);
  if (typeof value !== "object" || value === null) return value;
  if (path.includes(value)) return "[Circular]";
  walk.nodes += 1;
  if (path.length >= MAX_CAUSE_DEPTH || walk.nodes > MAX_CAUSE_NODES) return "[Truncated]";
  const next = [...path, value];
  try {
    if (Array.isArray(value)) {
      const items = (value as unknown[]).map((item) => cleanCauseValue(item, next, walk));
      return items.some((item, index) => item !== (value as unknown[])[index]) ? items : value;
    }
    if (value instanceof URL) {
      const cleaned = redactUrlCredentials(value.href);
      return cleaned === value.href ? value : cleaned;
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
      const cleaned = redactUrlCredentials(text);
      return cleaned === text ? value : Buffer.from(cleaned, "latin1");
    }
    // Typed arrays and DataViews hold bytes, not properties.
    if (ArrayBuffer.isView(value)) return value;
    if (value instanceof String) {
      // The boxed text itself is what util.inspect prints, so it is redacted too.
      const text = value.valueOf();
      const cleanedText = redactUrlCredentials(text);
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
    return changed.size === 0 ? value : cloneWith(value, changed);
  } catch {
    return "[Unreadable]";
  }
}

/**
 * Returns `cause` with URL credentials removed from every string it can reach: the message and the
 * stack of an error (even when `stack` is an accessor), its own string properties and nested
 * `cause`, `AggregateError.errors`, arrays, plain objects, class instances, `Map` / `Set` entries,
 * buffers, and a `URL` (reduced to a redacted string). So `console.log(error)` / `util.inspect`
 * (which print the whole cause chain) cannot leak them. A value with nothing to redact is returned
 * as-is (same identity); otherwise a same-prototype copy is returned and the original is never
 * mutated. Depth and node count are bounded, and a value that cannot be read becomes
 * `"[Unreadable]"` rather than throwing.
 */
export function sanitizeCause(cause: unknown): unknown {
  return cleanCauseValue(cause, [], { nodes: 0 });
}
