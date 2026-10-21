// .env parsing + the rule for which .env values count as secrets (used by check-secrets.ts).
//
// NEVER log, throw or return a value in a message from this module — values only flow into the
// in-memory `Needle` list that scan.ts matches against files.

export interface EnvEntry {
  key: string;
  value: string;
  /** 1-based line of the assignment in the .env file. */
  line: number;
}

export interface Needle {
  key: string;
  value: string;
  line: number;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const QUOTES = ["'", '"', "`"];

const unescapeDouble = (s: string): string =>
  s.replace(/\\([nrt"\\])/g, (_m, c: string) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
  );

/** Index of the closing `quote` in `s` (double quotes honour `\"`), or -1. */
function closingQuote(s: string, quote: string): number {
  for (let i = 0; i < s.length; i += 1) {
    if (quote === '"' && s[i] === "\\") i += 1;
    else if (s[i] === quote) return i;
  }
  return -1;
}

/**
 * Parses dotenv-style text: optional `export ` prefix, CRLF/LF/CR line ends, BOM, `'`/`"`/backtick
 * quoted values (multi-line allowed), inline ` # comments` outside quotes, `#` comment lines.
 *
 * Fail-closed on ambiguity: where tools disagree about a value (dotenv strips ` # comment`, Docker
 * `--env-file` keeps it; `\n` escapes in double quotes), BOTH readings are emitted, so a secret is
 * matched whichever way the consuming tool reads the line.
 */
export function parseEnv(text: string): EnvEntry[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const entries: EnvEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = ASSIGNMENT.exec(lines[i] ?? "");
    const key = m?.[1];
    if (key === undefined) continue;
    const rest = (m?.[2] ?? "").trimStart();
    const lineNo = i + 1;
    const push = (value: string): void => {
      if (value !== "" && !entries.some((e) => e.key === key && e.value === value))
        entries.push({ key, value, line: lineNo });
    };
    const quote = QUOTES.find((q) => rest.startsWith(q));
    if (quote !== undefined) {
      let body = rest.slice(1);
      let end = closingQuote(body, quote);
      let last = i;
      while (end === -1 && last + 1 < lines.length) {
        last += 1;
        body += `\n${lines[last] ?? ""}`;
        end = closingQuote(body, quote);
      }
      if (end !== -1) {
        const raw = body.slice(0, end);
        push(quote === '"' ? unescapeDouble(raw) : raw);
        push(raw);
        i = last;
        continue;
      }
      // Unterminated quote: don't swallow the rest of the file; read this line as unquoted.
    }
    const bare = quote !== undefined ? rest.slice(1) : rest;
    const comment = /(^|\s)#/.exec(bare);
    push((comment ? bare.slice(0, comment.index) : bare).trim());
    push(bare.trim());
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// What counts as a secret
//
//   * Key name looks secret (KEY, SECRET, TOKEN, PASSWORD, CREDENTIAL, BEARER, CLIENT_ID,
//     SELLER_ID, PRIVATE, SIGNATURE, COOKIE, SESSION) and does not end in _HEADER/_FIELD/_NAME/
//     _TYPE/_PREFIX (those hold names of things, e.g. X_API_KEY_HEADER=Authorization, and are
//     judged like any other key): the value is checked from 4 characters up, but a value of 4-15
//     characters must contain a digit, and one of 4-7 characters a letter AND a digit; an
//     all-letter value under 16 characters is a word (header/field/enum name), never a secret.
//   * Any other key: the value must be token-shaped — 16+ characters, no whitespace, at least one
//     letter and one digit. A comma-separated value is judged per part.
//   * Never a secret, whatever the key: empty, boolean-ish (true/false/yes/no/on/off/null/none),
//     placeholders (YOUR_..., CHANGE_ME, <...>, ${VAR}, xxxx), plain URLs (no userinfo, no
//     key/token/secret/sig/password query parameter). Additionally, for non-secret-named keys:
//     hostnames and filesystem paths.
//   * Values below 12 characters are matched on word boundaries only (see scan.ts), so a short
//     seller id cannot trigger inside a longer identifier.
// ---------------------------------------------------------------------------------------------
const SECRET_NAME =
  /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|BEARER|CLIENT_ID|SELLER_ID|PRIVATE|SIGNATURE|COOKIE|SESSION/i;
const NAME_OF_THING = /_(?:HEADER|FIELD|NAME|TYPE|PREFIX)$/i;
const MIN_NAMED = 4;
const MIN_NAMED_WORDLESS = 16;
const MIN_UNNAMED = 16;

const PLACEHOLDER = [
  /^(?:YOUR|CHANGE|REPLACE|INSERT|ENTER)[_-]/i,
  /[_-]HERE$/i,
  /^<[^>]*>$/,
  /^\$\{[^}]*\}$/,
  /^(?:x{4,}|\*{4,}|\.{3,}|\?{4,})$/i,
  /^(?:changeme|todo|tbd|example|placeholder|dummy)$/i,
];
const BOOLEANISH = /^(?:true|false|yes|no|on|off|null|none|undefined)$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SECRET_QUERY = /[?&;][^=&;\s]*(?:key|token|secret|pass|sig|auth)[^=&;\s]*=/i;
const HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
const PATHLIKE = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])/;

const hasLetter = (s: string): boolean => /[A-Za-z]/.test(s);
const hasDigit = (s: string): boolean => /\d/.test(s);

function isPlainUrl(value: string): boolean {
  if (!URL_SCHEME.test(value)) return false;
  const authority = value.replace(URL_SCHEME, "").split(/[/?#]/, 1)[0] ?? "";
  return !authority.includes("@") && !SECRET_QUERY.test(value);
}

function isCheckable(named: boolean, value: string): boolean {
  if (BOOLEANISH.test(value) || PLACEHOLDER.some((re) => re.test(value))) return false;
  if (isPlainUrl(value)) return false;
  if (named) {
    if (value.length < MIN_NAMED) return false;
    if (value.length >= MIN_NAMED_WORDLESS) return true;
    return hasDigit(value) && (value.length >= 8 || hasLetter(value));
  }
  if (value.length < MIN_UNNAMED || /\s/.test(value)) return false;
  if (HOSTNAME.test(value) || PATHLIKE.test(value)) return false;
  return hasLetter(value) && hasDigit(value);
}

/** Needles to search for: every secret-shaped value in the parsed .env (see rule above). */
export function selectNeedles(entries: readonly EnvEntry[]): Needle[] {
  const needles: Needle[] = [];
  const seen = new Set<string>();
  for (const { key, value, line } of entries) {
    const named = SECRET_NAME.test(key) && !NAME_OF_THING.test(key);
    const candidates = named ? [value] : value.split(",");
    for (const piece of candidates.flatMap((c) => (c.includes("\n") ? c.split("\n") : [c]))) {
      const v = piece.trim();
      // PEM armour lines ("-----BEGIN ...") are boilerplate, not secret material.
      if (v.startsWith("-----") || !isCheckable(named, v)) continue;
      if (seen.has(`${key}\0${v}`)) continue;
      seen.add(`${key}\0${v}`);
      needles.push({ key, value: v, line });
    }
  }
  return needles;
}

/** Decodes a .env file's bytes: UTF-8 (default) or UTF-16LE/BE (BOM, or NULs without a BOM). */
export function decodeEnvFile(buf: Buffer): string {
  if (buf[0] === 0xfe && buf[1] === 0xff)
    return Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)))
      .swap16()
      .toString("utf16le");
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  // No BOM: NUL at an even offset first means UTF-16BE (ASCII high byte), otherwise UTF-16LE.
  if (buf.includes(0)) {
    return buf[0] === 0 && buf[1] !== 0
      ? Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)))
          .swap16()
          .toString("utf16le")
      : buf.toString("utf16le");
  }
  return buf.toString("utf8");
}
