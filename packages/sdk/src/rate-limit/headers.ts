import type { NeweggMarketplace, RateLimitInfo } from "../types.js";
import { parsePacificTimestamp } from "../platform/dates.js";
import { asNumber } from "../schemas/wire.js";

/** Builds the store key for a marketplace/seller/operation triple. */
export function rateLimitKey(
  marketplace: NeweggMarketplace,
  sellerId: string,
  operation: string,
): string {
  return `${marketplace}:${sellerId}:${operation}`;
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  return raw == null ? undefined : asNumber(raw);
}

function dateHeader(headers: Headers, name: string): Date | undefined {
  const raw = headers.get(name);
  return raw == null ? undefined : parsePacificTimestamp(raw);
}

/**
 * Parses Newegg's diagnostic rate-limit headers into {@link RateLimitInfo}. Reset-time
 * headers are interpreted via {@link parsePacificTimestamp} (ISO, epoch, or Pacific
 * wall-clock). Returns `undefined` when no relevant headers are present.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const info: RateLimitInfo = {};
  let present = false;

  const requestLimit = numberHeader(headers, "x-ratelimit-limit");
  if (requestLimit !== undefined) {
    info.requestLimit = requestLimit;
    present = true;
  }
  const requestRemaining = numberHeader(headers, "x-ratelimit-remaining");
  if (requestRemaining !== undefined) {
    info.requestRemaining = requestRemaining;
    present = true;
  }
  const requestResetAt = dateHeader(headers, "x-ratelimit-resettime");
  if (requestResetAt) {
    info.requestResetAt = requestResetAt;
    present = true;
  }
  const recordLimit = numberHeader(headers, "x-recordcount-limit");
  if (recordLimit !== undefined) {
    info.recordLimit = recordLimit;
    present = true;
  }
  const recordRemaining = numberHeader(headers, "x-recordcount-remaining");
  if (recordRemaining !== undefined) {
    info.recordRemaining = recordRemaining;
    present = true;
  }
  const recordResetAt = dateHeader(headers, "x-recordcount-resettime");
  if (recordResetAt) {
    info.recordResetAt = recordResetAt;
    present = true;
  }

  return present ? info : undefined;
}
