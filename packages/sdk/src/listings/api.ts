import { randomUUID } from "node:crypto";
import type {
  CreateListingInput,
  FeedSubmission,
  ListingCreatePreview,
  ListingsApi,
  RequestOptions,
} from "../types.js";
import type { NeweggHttpClient } from "../client/http.js";
import { chunk } from "../util.js";
import { SUBMIT_FEED_PATH, submitLedgeredFeedChunk } from "../feeds/submit-core.js";
import { buildExistingItemEnvelope } from "./envelope.js";
import { normalizeCreateListings } from "./validate.js";
import type { NormalizedCreateListing } from "../types.js";
import {
  EXISTING_ITEM_QUERY_FLAG,
  ITEM_FEED_REQUEST_TYPE,
  LISTING_FEED_MAX_RECORDS,
} from "./constants.js";

/** Activation warnings shared by `previewCreate` and `create` so both surface the same guidance. */
function activationWarnings(items: NormalizedCreateListing[]): string[] {
  const activeCount = items.filter((item) => item.activate).length;
  return [
    activeCount === 0
      ? "All offers will be created DEACTIVATED (ActivationMark=False); activate explicitly later."
      : `${activeCount} offer(s) will be created ACTIVE and immediately for sale.`,
  ];
}

/** Existing-item listing creation over the ITEM_DATA&v2 feed (contracts §13). WRITE. */
export class ListingsApiImpl implements ListingsApi {
  readonly #http: NeweggHttpClient;

  constructor(http: NeweggHttpClient) {
    this.#http = http;
  }

  previewCreate(input: CreateListingInput | CreateListingInput[]): ListingCreatePreview {
    const items = normalizeCreateListings(Array.isArray(input) ? input : [input]);
    const chunks = chunk(items, LISTING_FEED_MAX_RECORDS);
    return {
      marketplace: this.#http.config.marketplace,
      items,
      itemCount: items.length,
      chunkCount: chunks.length,
      warnings: activationWarnings(items),
      envelopes: chunks.map(buildExistingItemEnvelope),
    };
  }

  async create(
    input: CreateListingInput | CreateListingInput[],
    options: RequestOptions = {},
  ): Promise<FeedSubmission> {
    const correlationId = options.correlationId ?? randomUUID();
    const items = normalizeCreateListings(Array.isArray(input) ? input : [input]);
    const chunks = chunk(items, LISTING_FEED_MAX_RECORDS);
    const feeds: FeedSubmission["feeds"] = [];
    const itemAssignments: FeedSubmission["itemAssignments"] = [];
    let rateLimit: FeedSubmission["rateLimit"];

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunkItems = chunks[chunkIndex] ?? [];
      const bodyText = JSON.stringify(buildExistingItemEnvelope(chunkItems));
      const { job, rateLimit: chunkRate } = await submitLedgeredFeedChunk({
        http: this.#http,
        path: `${this.#http.adapter.prefix}${SUBMIT_FEED_PATH}`,
        requestType: ITEM_FEED_REQUEST_TYPE,
        rawQuerySuffix: EXISTING_ITEM_QUERY_FLAG,
        bodyText,
        recordCount: chunkItems.length,
        chunkIndex,
        correlationId,
        options,
      });
      feeds.push(job);
      for (const item of chunkItems) {
        itemAssignments.push({
          inputIndex: item.inputIndex,
          requestId: job.requestId,
          chunkIndex,
        });
      }
      rateLimit = chunkRate ?? rateLimit;
    }
    return {
      feeds,
      deduplicatedItemCount: 0,
      itemAssignments,
      warnings: activationWarnings(items),
      correlationId,
      rateLimit,
    };
  }
}
