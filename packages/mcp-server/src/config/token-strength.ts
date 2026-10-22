/**
 * Strength rule and generator for the two operator secrets: the HTTP bearer token
 * (`NEWEGG_MCP_HTTP_BEARER_TOKEN`) and the preview-integrity HMAC key
 * (`NEWEGG_MCP_PREVIEW_HMAC_KEY`).
 *
 * A length floor plus a count of different characters let patterned secrets through
 * (`"abcdefghijkl".repeat(3)`, keyboard rows, ascending runs). The rule therefore also estimates how
 * many bits of the token are unpredictable. The token is parsed greedily: a stretch of 4+ characters
 * that repeats earlier text, steps up or down by one character code (`abcd`, `4321`) or follows a
 * keyboard row (`asdf`) costs a flat {@link PIECE_BITS}, every other character costs
 * `log2(distinct characters in the token)` bits. Random hex, base64 and base64url output keep almost
 * all of their bits (a 32-character hex token estimates at ~128, a 64-character one at ~256) while the
 * patterned examples above fall far under {@link MIN_ENTROPY_BITS}. No heuristic can recognise a
 * non-repeating dictionary phrase; generate secrets instead of choosing them.
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

/** Length of the longest stretch at `index` that repeats text starting earlier (overlap allowed). */
function repeatLength(token: string, index: number): number {
  let best = 0;
  for (let from = 0; from < index; from += 1) {
    let length = 0;
    while (index + length < token.length && token[from + length] === token[index + length]) {
      length += 1;
    }
    best = Math.max(best, length);
  }
  return best;
}

/** Length of the stretch at `index` whose character codes move by a constant +1 or -1. */
function sequenceLength(lower: string, index: number): number {
  if (index + 1 >= lower.length) return 0;
  const step = lower.charCodeAt(index + 1) - lower.charCodeAt(index);
  if (step !== 1 && step !== -1) return 0;
  let length = 2;
  while (
    index + length < lower.length &&
    lower.charCodeAt(index + length) - lower.charCodeAt(index + length - 1) === step
  ) {
    length += 1;
  }
  return length;
}

/** Length of the longest stretch at `index` that is a substring of a keyboard row. */
function keyboardLength(lower: string, index: number): number {
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

/** Estimated unpredictable bits in `token` (see the module comment). */
function estimateEntropyBits(token: string): number {
  const lower = token.toLowerCase();
  const literalBits = Math.log2(Math.max(2, new Set(token).size));
  let bits = 0;
  let index = 0;
  while (index < token.length) {
    const piece = Math.max(
      repeatLength(token, index),
      sequenceLength(lower, index),
      keyboardLength(lower, index),
    );
    if (piece >= MIN_PIECE_LENGTH) {
      bits += PIECE_BITS;
      index += piece;
    } else {
      bits += literalBits;
      index += 1;
    }
  }
  return bits;
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
