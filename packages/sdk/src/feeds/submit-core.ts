import type { FeedJob, RateLimitInfo, RequestOptions } from "../types.js";
import type { RequestSpec } from "../platform/index.js";
import type { HttpResult, NeweggHttpClient, RequestContext } from "../client/http.js";
import { sha256Hex } from "../auth/index.js";
import {
  IndeterminateFeedSubmissionError,
  NeweggError,
  NeweggFeedSubmissionError,
} from "../errors/index.js";
import { LogEvent } from "../logging/index.js";
import { toTimestamp } from "../platform/dates.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { Operation } from "../client/operations.js";
import { fullJitterDelay } from "../client/retry.js";
import { TransportError } from "../client/transport.js";
import { delay, isAbortError } from "../util.js";
import { parseFeedSubmitResponse } from "./parse.js";

const AMBIGUOUS_HTTP_STATUSES = new Set([408, 502, 503, 504]);

export interface LedgeredChunkArgs {
  http: NeweggHttpClient;
  /** e.g. `${adapter.prefix}datafeedmgmt/feeds/submitfeed` */
  path: string;
  requestType: string;
  rawQuerySuffix?: string;
  bodyText: string;
  recordCount: number;
  chunkIndex: number;
  /** Base correlation id; the chunk uses `${correlationId}-c${chunkIndex}`. */
  correlationId: string;
  options: RequestOptions;
}

/**
 * Submits one chunk. Acquires the local budget, then executes with pre-send-only retry.
 * Ambiguous failures (timeout/reset after dispatch, or 408/5xx) throw
 * {@link IndeterminateFeedSubmissionError} and leave the ledger in `submitting`.
 */
async function submitChunk(
  http: NeweggHttpClient,
  spec: RequestSpec,
  ctx: RequestContext,
  ledger: { opKey: string; payloadHash: string; submittedAtIso: string; correlationId: string },
): Promise<HttpResult> {
  const { operationStore, retry, logger, marketplace } = http.config;
  await http.acquireRateLimit(ctx);

  let attempt = 0;
  for (;;) {
    try {
      return await http.executeOnce(spec, ctx);
    } catch (err) {
      if (isAbortError(err)) throw err;

      const preSendRetryable =
        err instanceof TransportError &&
        err.phase === "pre-send" &&
        attempt + 1 < retry.maxAttempts;
      if (preSendRetryable) {
        const delayMs = fullJitterDelay(attempt, retry);
        logger.info(LogEvent.RetryScheduled, {
          correlationId: ctx.correlationId,
          marketplace,
          operation: ctx.operation,
          attempt: attempt + 1,
          delayMs,
          reason: "pre_send_transport",
        });
        await delay(delayMs, ctx.signal);
        attempt++;
        continue;
      }

      const ambiguous =
        (err instanceof TransportError && err.phase === "ambiguous") ||
        (err instanceof NeweggError &&
          err.httpStatus !== undefined &&
          AMBIGUOUS_HTTP_STATUSES.has(err.httpStatus));
      if (ambiguous) {
        logger.warn(LogEvent.IndeterminateSubmission, {
          correlationId: ctx.correlationId,
          marketplace,
          sellerIdHash: http.sellerIdHash,
          payloadHash: ledger.payloadHash,
        });
        // Leave the ledger in "submitting": the payload may have reached Newegg.
        throw new IndeterminateFeedSubmissionError(
          "The feed submission may have reached Newegg but the outcome is unknown.",
          {
            payloadHash: ledger.payloadHash,
            marketplace,
            submittedAtIso: ledger.submittedAtIso,
            correlationId: ledger.correlationId,
            cause: err,
          },
        );
      }

      // Definitive failure (pre-send exhausted, or 4xx / rate-limit): record and surface.
      await operationStore.put(ledger.opKey, {
        state: "failed",
        payloadHash: ledger.payloadHash,
        updatedAt: new Date().toISOString(),
      });
      if (err instanceof TransportError) {
        throw new NeweggFeedSubmissionError(
          "Feed submission failed before dispatch and was not sent.",
          { correlationId: ctx.correlationId, retryable: false, cause: err.cause },
        );
      }
      throw err;
    }
  }
}

/** Submits ONE feed chunk through the dedup ledger + ambiguity-aware retry path.
 * Behavior is exactly the former FeedsApiImpl per-chunk logic (ADR 0004). */
export async function submitLedgeredFeedChunk(
  args: LedgeredChunkArgs,
): Promise<{ job: FeedJob; rateLimit?: RateLimitInfo }> {
  const { http, options } = args;
  const { marketplace, sellerId, operationStore, logger } = http.config;
  const { correlationId } = args;

  const bodyText = args.bodyText;
  const payloadHash = sha256Hex(bodyText);
  const opKey = `${marketplace}:${sellerId}:feed:${payloadHash}`;
  const submittedAtIso = new Date().toISOString();

  const existing = await operationStore.get(opKey);
  if (existing && (existing.state === "submitting" || existing.state === "submitted")) {
    logger.warn(LogEvent.IndeterminateSubmission, {
      correlationId,
      marketplace,
      sellerIdHash: http.sellerIdHash,
      payloadHash,
      priorState: existing.state,
    });
    throw new IndeterminateFeedSubmissionError(
      existing.state === "submitted"
        ? "An identical feed payload was already submitted; not resubmitting."
        : "An identical feed payload is already in flight; not resubmitting.",
      {
        payloadHash,
        marketplace,
        submittedAtIso,
        correlationId,
        neweggRequestId: existing.requestIds?.[0],
        details: { priorState: existing.state, existingRequestIds: existing.requestIds },
      },
    );
  }

  await operationStore.put(opKey, {
    state: "submitting",
    payloadHash,
    updatedAt: submittedAtIso,
  });

  const chunkCorrelation = `${correlationId}-c${args.chunkIndex}`;
  const spec: RequestSpec = {
    method: "POST",
    path: args.path,
    query: { requesttype: args.requestType },
    bodyText,
    rawQuerySuffix: args.rawQuerySuffix,
  };
  const ctx: RequestContext = {
    operation: Operation.FeedSubmit,
    correlationId: chunkCorrelation,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.FeedSubmit),
    recordCost: args.recordCount,
  };

  const result = await submitChunk(http, spec, ctx, {
    opKey,
    payloadHash,
    submittedAtIso,
    correlationId,
  });

  const parsed = parseFeedSubmitResponse(result.json);
  if (!parsed.isSuccess || !parsed.requestId) {
    await operationStore.put(opKey, {
      state: "failed",
      payloadHash,
      updatedAt: new Date().toISOString(),
    });
    throw new NeweggFeedSubmissionError("Newegg rejected the feed submission.", {
      correlationId: chunkCorrelation,
      httpStatus: result.status,
      details: { isSuccess: parsed.isSuccess },
    });
  }

  const requestId = parsed.requestId;
  await operationStore.put(opKey, {
    state: "submitted",
    payloadHash,
    requestIds: [requestId],
    updatedAt: new Date().toISOString(),
  });

  const job: FeedJob = {
    requestId,
    requestType: args.requestType,
    marketplace,
    status: parsed.status,
    itemCount: args.recordCount,
    chunkIndex: args.chunkIndex,
    submittedAt: toTimestamp(parsed.requestDate),
    correlationId: chunkCorrelation,
  };
  logger.info(LogEvent.FeedSubmitted, {
    correlationId: chunkCorrelation,
    marketplace,
    sellerIdHash: http.sellerIdHash,
    requestId,
    itemCount: args.recordCount,
    chunkIndex: args.chunkIndex,
  });

  return { job, rateLimit: result.rateLimit };
}
