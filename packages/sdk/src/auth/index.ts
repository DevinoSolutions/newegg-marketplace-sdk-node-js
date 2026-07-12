import { createHash } from "node:crypto";

/**
 * Auth header construction and seller-id hashing. Newegg uses raw header values (no scheme
 * prefix): `Authorization: <apiKey>` and `SecretKey: <secretKey>`.
 *
 * Credential hygiene here is by OMISSION rather than post-hoc scrubbing: the api key and secret
 * key go ONLY into outbound request headers (never logged, never placed in errors or `raw`
 * payloads); request logs carry the URL pathname only (never the `?sellerid=` query); and the
 * seller id is surfaced only as {@link hashSellerId}. Nothing observable ever contains a secret
 * or the raw seller id, so there is nothing to redact. Enforced by `test/auth.test.ts`.
 */

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

/** SHA-256 hash of the seller id, truncated to 12 hex chars — safe to log for correlation. */
export function hashSellerId(sellerId: string): string {
  return createHash("sha256").update(sellerId).digest("hex").slice(0, 12);
}

/** Full SHA-256 hex digest of an arbitrary payload string (used for feed payload hashes). */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
