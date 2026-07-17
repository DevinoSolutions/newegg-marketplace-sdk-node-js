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
import type { NeweggHttpClient } from "../client/http.js";
import { NeweggApiError } from "../errors/index.js";
import { parseUpstreamBody } from "../errors/parse-upstream.js";
import { LogEvent } from "../logging/index.js";
import { toTimestamp } from "../platform/dates.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { Operation } from "../client/operations.js";
import { chunk, delay } from "../util.js";
import { INVENTORY_FEED_MAX_RECORDS } from "./constants.js";
import { findStatusEntry, parseProcessingReport } from "./parse.js";
import { SUBMIT_FEED_PATH, submitLedgeredFeedChunk } from "./submit-core.js";
import {
  parseOrThrow,
  requireSellerPartNumbers,
  validateInventoryUpdates,
} from "../inventory/validate.js";
import { dedupeUpdates, warehouseIgnoredWarnings } from "../inventory/strategy.js";
import { submitInventoryFeedInputSchema } from "../schemas/inputs.js";

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
    const { marketplace } = this.#config;
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
    let rateLimit: FeedSubmission["rateLimit"];

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunkItems = chunks[chunkIndex] ?? [];
      const envelope = this.#http.adapter.buildFeedEnvelope(chunkItems.map(toFeedItemInput));
      const bodyText = JSON.stringify(envelope);

      const { job, rateLimit: chunkRate } = await submitLedgeredFeedChunk({
        http: this.#http,
        path: `${this.#http.adapter.prefix}${SUBMIT_FEED_PATH}`,
        requestType: this.#http.adapter.feedRequestType,
        bodyText,
        recordCount: chunkItems.length,
        chunkIndex,
        correlationId,
        options,
      });

      feeds.push(job);
      for (const item of chunkItems) {
        itemAssignments.push({ inputIndex: item.inputIndex, requestId: job.requestId, chunkIndex });
      }
      rateLimit = chunkRate ?? rateLimit;
    }

    return { feeds, deduplicatedItemCount, itemAssignments, warnings, correlationId, rateLimit };
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
