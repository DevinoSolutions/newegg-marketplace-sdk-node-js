import { randomUUID } from "node:crypto";
import type {
  FeedSubmission,
  GetVolumeDiscountInput,
  RequestOptions,
  VolumeDiscountSnapshot,
  VolumeDiscountUpdateOrNormalized,
  VolumeDiscountUpdatePreview,
  VolumeDiscountsApi,
} from "../types.js";
import type { NeweggHttpClient } from "../client/http.js";
import { NeweggApiError, NeweggValidationError } from "../errors/index.js";
import { Operation } from "../client/operations.js";
import { SUBMIT_FEED_PATH, submitLedgeredFeedChunk } from "../feeds/submit-core.js";
import {
  assertVolumeDiscountWriteSupported,
  buildVolumeDiscountEnvelope,
  getVolumeDiscountPlatform,
  parseVolumeDiscount,
  volumeDiscountReadRequest,
} from "../platform/volume-discount.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { sanitizeRaw } from "../reportmgmt/redact.js";
import { chunk } from "../util.js";
import {
  VOLUME_DISCOUNT_FEED_MAX_RECORDS,
  VOLUME_DISCOUNT_FEED_REQUEST_TYPE,
  VOLUME_DISCOUNT_NOT_FOUND_ERROR_CODES,
} from "./constants.js";
import { normalizeVolumeDiscountUpdates, volumeDiscountWarnings } from "./validate.js";

function toList<T>(input: T | T[]): T[] {
  return Array.isArray(input) ? input : [input];
}

/**
 * Volume discounts (contracts §22). `get`/`tryGet` are Get Volume Discount, a READ although sent
 * as `PUT`. `update` is the ONLY write: it submits the `VOLUME_DISCOUNT_DATA` feed through the
 * shared ledgered feed machinery (ADR 0004) and nothing else. The direct Submit Volume Discount
 * endpoint is never called (it errors on Newegg.ca, §22.2).
 */
export class VolumeDiscountsApiImpl implements VolumeDiscountsApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  async get(
    input: GetVolumeDiscountInput,
    options: RequestOptions = {},
  ): Promise<VolumeDiscountSnapshot> {
    if (input.neweggItemNumber === undefined && input.sellerPartNumber === undefined) {
      throw new NeweggValidationError("volumeDiscounts.get input validation failed.", [
        { path: "", message: "Provide neweggItemNumber or sellerPartNumber." },
      ]);
    }
    const { marketplace, sellerId } = this.#http.config;
    const correlationId = options.correlationId ?? randomUUID();
    const spec = volumeDiscountReadRequest(getVolumeDiscountPlatform(marketplace), input);
    const result = await this.#http.request(spec, {
      operation: Operation.VolumeDiscountGet,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.VolumeDiscountGet),
    });
    const parsed = parseVolumeDiscount(result.json);
    if (!parsed) {
      throw new NeweggApiError("Newegg returned no volume discount for the requested item.", {
        correlationId,
        httpStatus: result.status,
      });
    }
    const snapshot: VolumeDiscountSnapshot = {
      marketplace,
      tiers: parsed.tiers,
      correlationId,
      rateLimit: result.rateLimit,
    };
    if (parsed.neweggItemNumber !== undefined) snapshot.neweggItemNumber = parsed.neweggItemNumber;
    if (parsed.sellerPartNumber !== undefined) snapshot.sellerPartNumber = parsed.sellerPartNumber;
    if (options.includeRaw) snapshot.raw = sanitizeRaw(result.json);
    return snapshot;
  }

  async tryGet(
    input: GetVolumeDiscountInput,
    options: RequestOptions = {},
  ): Promise<VolumeDiscountSnapshot | undefined> {
    try {
      return await this.get(input, options);
    } catch (err) {
      if (
        err instanceof NeweggApiError &&
        err.neweggErrorCode !== undefined &&
        VOLUME_DISCOUNT_NOT_FOUND_ERROR_CODES.has(err.neweggErrorCode)
      ) {
        return undefined;
      }
      throw err;
    }
  }

  previewUpdate(
    input: VolumeDiscountUpdateOrNormalized | VolumeDiscountUpdateOrNormalized[],
  ): VolumeDiscountUpdatePreview {
    const { marketplace } = this.#http.config;
    assertVolumeDiscountWriteSupported(getVolumeDiscountPlatform(marketplace));
    const items = normalizeVolumeDiscountUpdates(toList(input));
    const chunks = chunk(items, VOLUME_DISCOUNT_FEED_MAX_RECORDS);
    return {
      marketplace,
      items,
      itemCount: items.length,
      chunkCount: chunks.length,
      warnings: volumeDiscountWarnings(items),
      envelopes: chunks.map(buildVolumeDiscountEnvelope),
    };
  }

  async update(
    input: VolumeDiscountUpdateOrNormalized | VolumeDiscountUpdateOrNormalized[],
    options: RequestOptions = {},
  ): Promise<FeedSubmission> {
    const { marketplace } = this.#http.config;
    assertVolumeDiscountWriteSupported(getVolumeDiscountPlatform(marketplace));
    const correlationId = options.correlationId ?? randomUUID();
    const items = normalizeVolumeDiscountUpdates(toList(input));
    const chunks = chunk(items, VOLUME_DISCOUNT_FEED_MAX_RECORDS);
    const feeds: FeedSubmission["feeds"] = [];
    const itemAssignments: FeedSubmission["itemAssignments"] = [];
    let rateLimit: FeedSubmission["rateLimit"];

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunkItems = chunks[chunkIndex] ?? [];
      const bodyText = JSON.stringify(buildVolumeDiscountEnvelope(chunkItems));
      const { job, rateLimit: chunkRate } = await submitLedgeredFeedChunk({
        http: this.#http,
        path: `${this.#http.adapter.prefix}${SUBMIT_FEED_PATH}`,
        requestType: VOLUME_DISCOUNT_FEED_REQUEST_TYPE,
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
    return {
      feeds,
      deduplicatedItemCount: 0,
      itemAssignments,
      warnings: volumeDiscountWarnings(items),
      correlationId,
      rateLimit,
    };
  }
}
