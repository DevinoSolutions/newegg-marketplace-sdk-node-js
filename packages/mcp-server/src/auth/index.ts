/**
 * Transport-agnostic auth/validation helpers for the Streamable HTTP transport. Kept out of
 * `server/` so they can be unit-tested without the MCP SDK. Nothing here logs or echoes
 * token material.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Both inputs are hashed to a fixed-length digest first so
 * `timingSafeEqual` never sees different-length buffers (which would throw and leak length
 * via the exception) and the comparison time is independent of where the strings differ.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Strips surrounding brackets from an IPv6 host literal (`[::1]` -> `::1`). */
function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

/** True for loopback hostnames: localhost, 127.0.0.0/8, and ::1. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = stripBrackets(hostname.trim().toLowerCase());
  if (h === "localhost" || h === "::1") {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Extracts the bearer token from an `Authorization` header value, or undefined. */
export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) {
    return undefined;
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  return match ? match[1] : undefined;
}

/** Returns the hostname portion (without port) of a `Host` header value, lower-cased. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) {
    // IPv6 literal: keep everything up to and including the closing bracket.
    const end = h.indexOf("]");
    return (end >= 0 ? h.slice(0, end + 1) : h).toLowerCase();
  }
  const colon = h.lastIndexOf(":");
  return (colon >= 0 ? h.slice(0, colon) : h).toLowerCase();
}

/**
 * Host-header allowlist: loopback hosts are always allowed; otherwise the full `host[:port]`
 * or its bare hostname must appear in `allowedHosts`. A missing Host header is rejected.
 */
export function isHostAllowed(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return false;
  }
  const hostname = hostnameOf(hostHeader);
  if (isLoopbackHostname(hostname)) {
    return true;
  }
  const allowed = new Set(allowedHosts.map((value) => value.trim().toLowerCase()));
  return allowed.has(hostHeader.trim().toLowerCase()) || allowed.has(hostname);
}

/**
 * Origin allowlist for browser clients. A request with no Origin header (non-browser client)
 * is allowed; a present Origin must match the configured allowlist exactly (case-insensitive).
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (origin === undefined) {
    return true;
  }
  const allowed = new Set(allowedOrigins.map((value) => value.trim().toLowerCase()));
  return allowed.has(origin.trim().toLowerCase());
}
