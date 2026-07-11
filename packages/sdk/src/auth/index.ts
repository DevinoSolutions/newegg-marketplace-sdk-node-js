import { createHash } from "node:crypto";

/**
 * Auth header construction and redaction. Newegg uses raw header values (no scheme prefix):
 * `Authorization: <apiKey>` and `SecretKey: <secretKey>`. These values must never appear in
 * logs, errors, or `raw` payloads — {@link redactHeaders} and {@link redactSellerInUrl} are
 * the single chokepoints for anything observable.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_HEADERS = new Set(["authorization", "secretkey"]);

export interface AuthHeaderInput {
  apiKey: string;
  secretKey: string;
  userAgent: string;
}

/** Builds the exact request headers Newegg expects, including credentials. */
export function buildRequestHeaders(input: AuthHeaderInput): Record<string, string> {
  return {
    Authorization: input.apiKey,
    SecretKey: input.secretKey,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": input.userAgent,
  };
}

/** Returns a plain-object copy of headers with credential values replaced by `[REDACTED]`. */
export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : String(value);
  }
  return out;
}

/** SHA-256 hash of the seller id, truncated to 12 hex chars — safe to log for correlation. */
export function hashSellerId(sellerId: string): string {
  return createHash("sha256").update(sellerId).digest("hex").slice(0, 12);
}

/** Full SHA-256 hex digest of an arbitrary payload string (used for feed payload hashes). */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** Returns the URL string with the `sellerid` query value masked — safe for logs/details. */
export function redactSellerInUrl(url: URL): string {
  const clone = new URL(url.toString());
  if (clone.searchParams.has("sellerid")) clone.searchParams.set("sellerid", REDACTED);
  return clone.toString();
}
