import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Auth header construction and seller-id hashing. Newegg uses raw header values (no scheme
 * prefix): `Authorization: <apiKey>` and `SecretKey: <secretKey>`.
 *
 * Credential hygiene here is by OMISSION rather than post-hoc scrubbing: the api key and secret
 * key go ONLY into outbound request headers (never logged, never placed in errors or `raw`
 * payloads); request logs carry the URL pathname only (never the `?sellerid=` query); and the
 * seller id is surfaced only as the keyed {@link hashSellerId} correlation token. Nothing
 * observable ever contains a secret or the raw seller id, so there is nothing to redact. Enforced by `test/auth.test.ts`.
 */

interface AuthHeaderInput {
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

/** Per-process HMAC key, created lazily on first use and never exposed or persisted. */
let sellerIdHashKey: Buffer | undefined;

/**
 * Opaque, log-safe correlation token for a seller id: HMAC-SHA-256 under a random per-process
 * key, truncated to 12 hex chars. Equal ids give equal tokens within one process (enough to
 * correlate log events), but the token differs across processes and cannot be reversed by
 * enumerating the small seller-id space (an unkeyed hash of a 4-6 character id can be brute
 * forced in milliseconds). Do not compare it across processes or treat it as a stable id.
 */
export function hashSellerId(sellerId: string): string {
  sellerIdHashKey ??= randomBytes(32);
  return createHmac("sha256", sellerIdHashKey).update(sellerId).digest("hex").slice(0, 12);
}

/** Full SHA-256 hex digest of an arbitrary payload string (used for feed payload hashes). */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
