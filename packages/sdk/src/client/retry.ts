import type { RetryOptions } from "../types.js";
import { type NeweggError, NeweggRateLimitError } from "../errors/index.js";

/** Full-jitter exponential backoff: `random(0, min(maxDelay, base * 2^attempt))`. */
export function fullJitterDelay(attempt: number, retry: Required<RetryOptions>): number {
  const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/**
 * Computes the delay before the next retry. Honors an explicit `retryAfterMs` on a rate-limit
 * error (already capped upstream at 5 minutes); otherwise uses full-jitter exponential backoff.
 */
export function computeRetryDelay(
  error: NeweggError,
  attempt: number,
  retry: Required<RetryOptions>,
): number {
  if (error instanceof NeweggRateLimitError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return fullJitterDelay(attempt, retry);
}
