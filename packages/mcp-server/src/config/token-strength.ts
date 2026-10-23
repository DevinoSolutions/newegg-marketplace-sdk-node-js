/**
 * Strength rule and generator for the two operator secrets: the HTTP bearer token
 * (`NEWEGG_MCP_HTTP_BEARER_TOKEN`) and the preview-integrity HMAC key
 * (`NEWEGG_MCP_PREVIEW_HMAC_KEY`).
 *
 * A length floor plus a count of different characters let patterned secrets through
 * (`"abcdefghijkl".repeat(3)`, keyboard rows, ascending runs). The rule therefore also estimates how
 * many bits of the token are unpredictable. The token is parsed greedily: a stretch of 4+ characters
 * that repeats earlier text, steps up or down by one or two character codes (`abcd`, `4321`,
 * `acegik`) or follows a keyboard row (`asdf`) costs {@link PIECE_BITS} (never more than the same
 * characters would cost one by one), every other character costs `log2(distinct characters in the
 * token)` bits. The token is also read as 2-4 interleaved lanes (`a1b2c3` is the two runs `abc` and
 * `123`) and the cheapest reading wins. Random hex, base64 and base64url output keep almost
 * all of their bits (a 32-character hex token estimates at ~128, a 64-character one at ~256) while the
 * patterned examples above fall far under {@link MIN_ENTROPY_BITS}. No heuristic can recognise a
 * non-repeating dictionary phrase, and patterns built from short chunks of different kinds
 * (`abcd1234efgh5678...`) can still pass; generate secrets instead of choosing
 * them.
 *
 * Reasons never contain the secret.
 */
import { randomBytes } from "node:crypto";

/** Shortest accepted secret (`openssl rand -hex 16` is 32 characters). */
const MIN_SECRET_LENGTH = 32;
/** Estimated unpredictable bits below which a secret is refused. */
const MIN_ENTROPY_BITS = 80;
/** Shortest stretch parsed as one predictable piece. */
const MIN_PIECE_LENGTH = 4;
/** What one predictable piece is assumed to cost an attacker, in bits. */
const PIECE_BITS = 16;

/** Keyboard rows, matched forwards and backwards and ignoring case. */
const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"].flatMap((row) => [
  row,
  [...row].reverse().join(""),
]);

/**
 * Earlier start positions of every 4-character window, filled in as the parse advances, so a repeat
 * is looked up instead of scanning the whole token for each position (a repeat shorter than
 * {@link MIN_PIECE_LENGTH} never counts as a piece, so only 4-grams need indexing).
 */
class RepeatIndex {
  readonly #starts = new Map<number, number[]>();
  #indexed = 0;

  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  /** A 32-bit hash of the 4-gram at `at`; a collision only adds a candidate, which the comparison below rejects. */
  #gramKey(at: number): number {
    const token = this.#token;
    let key = 0;
    for (let offset = 0; offset < MIN_PIECE_LENGTH; offset += 1) {
      key = (Math.imul(key, 65599) + token.charCodeAt(at + offset)) | 0;
    }
    return key;
  }

  /** Length of the longest stretch at `index` that repeats text starting earlier (overlap allowed), 0 if under 4. */
  repeatLength(index: number): number {
    const token = this.#token;
    for (; this.#indexed < index; this.#indexed += 1) {
      if (this.#indexed + MIN_PIECE_LENGTH > token.length) break;
      const gram = this.#gramKey(this.#indexed);
      const list = this.#starts.get(gram);
      if (list === undefined) this.#starts.set(gram, [this.#indexed]);
      else list.push(this.#indexed);
    }
    const candidates =
      index + MIN_PIECE_LENGTH > token.length ? undefined : this.#starts.get(this.#gramKey(index));
    let best = 0;
    for (const from of candidates ?? []) {
      let length = 0;
      while (index + length < token.length && token[from + length] === token[index + length]) {
        length += 1;
      }
      best = Math.max(best, length);
    }
    return best;
  }
}

/** Length of the stretch at `index` whose character codes move by a constant +-1 or +-2. */
function sequenceLength(lower: string, index: number): number {
  if (index + 1 >= lower.length) return 0;
  const step = lower.charCodeAt(index + 1) - lower.charCodeAt(index);
  if (Math.abs(step) !== 1 && Math.abs(step) !== 2) return 0;
  let length = 2;
  while (
    index + length < lower.length &&
    lower.charCodeAt(index + length) - lower.charCodeAt(index + length - 1) === step
  ) {
    length += 1;
  }
  return length;
}

/** `ADJACENT_PAIRS[a * 128 + b]` is 1 when `a` is followed by `b` somewhere in a keyboard row. */
const ADJACENT_PAIRS = new Uint8Array(128 * 128);
for (const row of KEYBOARD_ROWS) {
  for (let at = 0; at + 1 < row.length; at += 1) {
    ADJACENT_PAIRS[row.charCodeAt(at) * 128 + row.charCodeAt(at + 1)] = 1;
  }
}

/** Length of the longest stretch at `index` that is a substring of a keyboard row. */
function keyboardLength(lower: string, index: number): number {
  // A stretch of 4+ needs its first two characters adjacent in a row; reject the rest cheaply.
  const first = lower.charCodeAt(index);
  const second = lower.charCodeAt(index + 1);
  if (!(first < 128 && second < 128) || ADJACENT_PAIRS[first * 128 + second] !== 1) return 0;
  let best = 0;
  for (const row of KEYBOARD_ROWS) {
    for (
      let start = row.indexOf(lower[index] ?? "");
      start >= 0;
      start = row.indexOf(lower[index] ?? "", start + 1)
    ) {
      let length = 0;
      while (
        start + length < row.length &&
        index + length < lower.length &&
        row[start + length] === lower[index + length]
      ) {
        length += 1;
      }
      best = Math.max(best, length);
    }
  }
  return best;
}

/** Bits for `token` read as one stream, with `literalBits` for every character outside a piece. */
function streamBits(token: string, literalBits: number): number {
  const lower = token.toLowerCase();
  const repeats = new RepeatIndex(token);
  let bits = 0;
  let index = 0;
  while (index < token.length) {
    const piece = Math.max(
      repeats.repeatLength(index),
      sequenceLength(lower, index),
      keyboardLength(lower, index),
    );
    if (piece >= MIN_PIECE_LENGTH) {
      bits += Math.min(PIECE_BITS, piece * literalBits);
      index += piece;
    } else {
      bits += literalBits;
      index += 1;
    }
  }
  return bits;
}

/** Longest interleave tried: `a1b2` is 2 lanes, `a1xb2y` is 3. */
const MAX_LANES = 4;

/** Estimated unpredictable bits in `token` (see the module comment). */
function estimateEntropyBits(token: string): number {
  // Every reading prices a literal character from the whole token's alphabet, so a lane that
  // happens to use few characters cannot look cheaper than it is.
  const literalBits = Math.log2(Math.max(2, new Set(token).size));
  let best = streamBits(token, literalBits);
  // Already refused: the lane readings can only lower the estimate, so skip them.
  if (best < MIN_ENTROPY_BITS) return best;
  for (let lanes = 2; lanes <= MAX_LANES; lanes += 1) {
    let total = 0;
    for (let lane = 0; lane < lanes; lane += 1) {
      let chars = "";
      for (let position = lane; position < token.length; position += lanes) {
        chars += token[position];
      }
      total += streamBits(chars, literalBits);
    }
    best = Math.min(best, total);
    if (best < MIN_ENTROPY_BITS) return best;
  }
  return best;
}

/**
 * Why `token` is too weak to guard the HTTP transport or key the preview MAC, or undefined when it is
 * acceptable: shorter than 32 characters, or too predictable. The reason never contains the token.
 */
export function weakBearerTokenReason(token: string): string | undefined {
  if (token.length < MIN_SECRET_LENGTH) {
    return `must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  if (estimateEntropyBits(token) < MIN_ENTROPY_BITS) {
    return "is too predictable (repeated or sequential characters, or too little variety)";
  }
  return undefined;
}

/**
 * A fresh random secret that passes {@link weakBearerTokenReason}: 32 random bytes as 64 hex
 * characters, what `openssl rand -hex 32` prints. Re-drawn in the (astronomically unlikely) event
 * that the draw is flagged as weak.
 */
export function generateSecretToken(): string {
  for (;;) {
    const token = randomBytes(32).toString("hex");
    if (weakBearerTokenReason(token) === undefined) return token;
  }
}
