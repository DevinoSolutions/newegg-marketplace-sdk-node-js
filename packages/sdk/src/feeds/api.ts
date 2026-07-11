import { randomUUID } from "node:crypto";
import type {
  FeedJob,
  FeedResult,
  FeedsApi,
  FeedStatusReport,
  FeedSubmission,
  FeedWaitOutcome,
  NormalizedInventoryUpdate,
  RequestOptions,
  SubmitInventoryFeedInput,
  WaitForResultOptions,
} from "../types.js";
import type { FeedItemInput, RequestSpec } from "../platform/index.js";
import type { HttpResult, NeweggHttpClient, RequestContext } from "../client/http.js";
import { sha256Hex } from "../auth/index.js";
import {
  IndeterminateFeedSubmissionError,
  NeweggApiError,
  NeweggError,
  NeweggFeedSubmissionError,
} from "../errors/index.js";
import { parseUpstreamBody } from "../errors/parse-upstream.js";
import { LogEvent } from "../logging/index.js";
import { toTimestamp } from "../platform/dates.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { Operation } from "../client/operations.js";
import { fullJitterDelay } from "../client/retry.js";
import { TransportError } from "../client/transport.js";
import { chunk, delay, isAbortError } from "../util.js";
import { INVENTORY_FEED_MAX_RECORDS } from "./constants.js";
import { findStatusEntry, parseFeedSubmitResponse, parseProcessingReport } from "./parse.js";
import {
  parseOrThrow,
  requireSellerPartNumbers,
  validateInventoryUpdates,
} from "../inventory/validate.js";
import { dedupeUpdates, warehouseIgnoredWarnings } from "../inventory/strategy.js";
import { submitInventoryFeedInputSchema } from "../schemas/inputs.js";

const AMBIGUOUS_HTTP_STATUSES = new Set([408, 502, 503, 504]);

function toFeedItemInput(update: NormalizedInventoryUpdate): FeedItemInput {
  return {
    sellerPartNumber: update.identifier.value,
    warehouseLocation: update.warehouseLocation,
    quantity: update.quantity,
  };
}

/** Feeds API: submit, status, result, and bounded polling. */
export class FeedsApiImpl implements FeedsApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  get #config() {
    return this.#http.config;
  }

  /** Submits an inventory feed, chunked at 10,000 records, with a per-chunk dedup ledger. */
  async submitInventoryFeed(
    input: SubmitInventoryFeedInput,
    options: RequestOptions = {},
  ): Promise<FeedSubmission> {
    const { marketplace, sellerId, operationStore, logger } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const validated = parseOrThrow(
      submitInventoryFeedInputSchema,
      input,
      "submitInventoryFeed input validation failed.",
    );
    const normalized = validateInventoryUpdates(validated.items, {
      marketplace,
      maxQuantity: this.#config.maxQuantity,
    });
    requireSellerPartNumbers(normalized);
    const { deduped, deduplicatedItemCount } = dedupeUpdates(marketplace, normalized);
    const warnings = warehouseIgnoredWarnings(marketplace, deduped);

    const chunks = chunk(deduped, INVENTORY_FEED_MAX_RECORDS);
    const feeds: FeedJob[] = [];
    const itemAssignments: FeedSubmission["itemAssignments"] = [];
    let rateLimit = undefined as FeedSubmission["rateLimit"];

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunkItems = chunks[chunkIndex] ?? [];
      const envelope = this.#http.adapter.buildFeedEnvelope(chunkItems.map(toFeedItemInput));
      const bodyText = JSON.stringify(envelope);
      const payloadHash = sha256Hex(bodyText);
      const opKey = `${marketplace}:${sellerId}:feed:${payloadHash}`;
      const submittedAtIso = new Date().toISOString();

      const existing = await operationStore.get(opKey);
      if (existing && (existing.state === "submitting" || existing.state === "submitted")) {
        logger.warn(LogEvent.IndeterminateSubmission, {
          correlationId,
          marketplace,
          sellerIdHash: this.#http.sellerIdHash,
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

      const chunkCorrelation = `${correlationId}-c${chunkIndex}`;
      const spec: RequestSpec = {
        method: "POST",
        path: `${this.#http.adapter.prefix}datafeedmgmt/feeds/submitfeed`,
        query: { requesttype: this.#http.adapter.feedRequestType },
        bodyText,
      };
      const ctx: RequestContext = {
        operation: Operation.FeedSubmit,
        correlationId: chunkCorrelation,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.FeedSubmit),
        recordCost: chunkItems.length,
      };

      const result = await this.#submitChunk(spec, ctx, {
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

      feeds.push({
        requestId,
        requestType: this.#http.adapter.feedRequestType,
        marketplace,
        status: parsed.status,
        itemCount: chunkItems.length,
        chunkIndex,
        submittedAt: toTimestamp(parsed.requestDate),
        correlationId: chunkCorrelation,
      });
      for (const item of chunkItems) {
        itemAssignments.push({ inputIndex: item.inputIndex, requestId, chunkIndex });
      }
      rateLimit = result.rateLimit ?? rateLimit;
      logger.info(LogEvent.FeedSubmitted, {
        correlationId: chunkCorrelation,
        marketplace,
        sellerIdHash: this.#http.sellerIdHash,
        requestId,
        itemCount: chunkItems.length,
        chunkIndex,
      });
    }

    return { feeds, deduplicatedItemCount, itemAssignments, warnings, correlationId, rateLimit };
  }

  /**
   * Submits one chunk. Acquires the local budget, then executes with pre-send-only retry.
   * Ambiguous failures (timeout/reset after dispatch, or 408/5xx) throw
   * {@link IndeterminateFeedSubmissionError} and leave the ledger in `submitting`.
   */
  async #submitChunk(
    spec: RequestSpec,
    ctx: RequestContext,
    ledger: { opKey: string; payloadHash: string; submittedAtIso: string; correlationId: string },
  ): Promise<HttpResult> {
    const { operationStore, retry, logger, marketplace } = this.#config;
    await this.#http.acquireRateLimit(ctx);

    let attempt = 0;
    for (;;) {
      try {
        return await this.#http.executeOnce(spec, ctx);
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
            sellerIdHash: this.#http.sellerIdHash,
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

  async getStatus(requestId: string, options: RequestOptions = {}): Promise<FeedStatusReport> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const spec: RequestSpec = {
      method: "PUT",
      path: `${this.#http.adapter.prefix}datafeedmgmt/feeds/status`,
      body: {
        OperationType: "GetFeedStatusRequest",
        RequestBody: {
          GetRequestStatus: {
            RequestIDList: { RequestID: [requestId] },
            MaxCount: "100",
            RequestStatus: "ALL",
          },
        },
      },
    };
    const result = await this.#http.request(spec, {
      operation: Operation.FeedStatus,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.FeedStatus),
    });
    const entry = findStatusEntry(result.json, requestId);
    return {
      requestId,
      status: entry?.status ?? "UNKNOWN",
      requestType: entry?.requestType,
      submittedAt: toTimestamp(entry?.requestDate),
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async getResult(requestId: string, options: RequestOptions = {}): Promise<FeedResult> {
    const { marketplace, sellerId } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const spec: RequestSpec = {
      method: "GET",
      path: `${this.#http.adapter.prefix}datafeedmgmt/feeds/result/${encodeURIComponent(requestId)}`,
    };
    const result = await this.#http.request(spec, {
      operation: Operation.FeedResult,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.FeedResult),
    });

    const report = parseProcessingReport(result.json);
    if (!report) {
      const entries = parseUpstreamBody(result.bodyText);
      const df006 = entries.find((entry) => entry.code === "DF006");
      throw new NeweggApiError(
        df006
          ? "Invalid feed request id (DF006)."
          : "Feed result did not contain a ProcessingReport.",
        {
          correlationId,
          httpStatus: result.status,
          neweggErrorCode: df006?.code,
          details: { entries },
        },
      );
    }

    this.#config.logger.info(LogEvent.FeedProcessingCompleted, {
      correlationId,
      marketplace,
      sellerIdHash: this.#http.sellerIdHash,
      requestId,
      summary: report.summary,
    });

    return {
      requestId,
      status: "FINISHED",
      summary: report.summary,
      records: report.records,
      correlationId,
      rateLimit: result.rateLimit,
      raw: options.includeRaw ? result.json : undefined,
    };
  }

  async waitForResult(
    requestId: string,
    options: WaitForResultOptions = {},
  ): Promise<FeedWaitOutcome> {
    const pollingIntervalMs = options.pollingIntervalMs ?? 5_000;
    const maxPollingIntervalMs = options.maxPollingIntervalMs ?? 60_000;
    const timeoutMs = options.timeoutMs ?? 900_000;
    const correlationId = options.correlationId ?? randomUUID();
    const startedAt = Date.now();
    let lastStatus: FeedStatusReport["status"] = "UNKNOWN";
    let iteration = 0;

    for (;;) {
      const report = await this.getStatus(requestId, {
        correlationId,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      if (report.status !== lastStatus) {
        this.#config.logger.info(LogEvent.FeedStatusChanged, {
          correlationId,
          marketplace: this.#config.marketplace,
          sellerIdHash: this.#http.sellerIdHash,
          requestId,
          from: lastStatus,
          to: report.status,
        });
        lastStatus = report.status;
      }

      if (report.status === "FINISHED") {
        const result = await this.getResult(requestId, {
          correlationId,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
        return { outcome: "finished", result };
      }
      if (report.status === "CANCELLED") {
        return { outcome: "cancelled", requestId, status: "CANCELLED" };
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        return { outcome: "timeout", requestId, lastStatus: report.status, elapsedMs };
      }
      const interval = Math.min(maxPollingIntervalMs, pollingIntervalMs * 1.5 ** iteration);
      const sleepMs = Math.min(interval, timeoutMs - elapsedMs);
      if (sleepMs <= 0) {
        return { outcome: "timeout", requestId, lastStatus: report.status, elapsedMs };
      }
      await delay(sleepMs, options.signal);
      iteration++;
    }
  }
}
