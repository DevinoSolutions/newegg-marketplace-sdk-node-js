import { randomUUID } from "node:crypto";
import type {
  FeedJobSummary,
  FeedResult,
  GetItemInput,
  GetManyInput,
  InventoryApi,
  InventoryBatchSnapshot,
  InventoryItemSnapshot,
  InventoryUpdate,
  InventoryUpdatePreview,
  InventoryUpdateResult,
  ItemIdentifier,
  ItemOutcome,
  ItemOutcomeStatus,
  NormalizedInventoryUpdate,
  PreviewOptions,
  RequestOptions,
  UpdateManyOptions,
  UpdateOptions,
} from "../types.js";
import type { DirectUpdateGroup, ParsedItem } from "../platform/index.js";
import type { NeweggHttpClient } from "../client/http.js";
import type { FeedsApiImpl } from "../feeds/api.js";
import { NeweggApiError, NeweggError } from "../errors/index.js";
import { LogEvent } from "../logging/index.js";
import { Operation } from "../client/operations.js";
import { identifierTypeCode } from "../platform/index.js";
import { rateLimitKey } from "../rate-limit/index.js";
import { chunk, isAbortError, mapWithConcurrency } from "../util.js";
import { DEFAULT_DIRECT_CONCURRENCY, GET_BATCH_INVENTORY_MAX_VALUES } from "./constants.js";
import {
  countZeroQuantity,
  decideStrategy,
  dedupeUpdates,
  warehouseIgnoredWarnings,
} from "./strategy.js";
import {
  validateGetItemInput,
  validateGetManyInput,
  validateInventoryUpdates,
} from "./validate.js";

// Newegg error codes that mean "no such item" on an inventory read (observed live: CT026 for
// an unknown SellerPartNumber or item number; CT010 for a UPC read when the seller has no
// offer on that UPC — 9/9 unlisted-product UPC probes on CA, 2026-07-18). `tryGetItem`
// converts ONLY these to `undefined`; every other error still throws. Extend this set only
// when another not-found code is confirmed.
const UNKNOWN_ITEM_ERROR_CODES = new Set(["CT026", "CT010"]);

function equalsIgnoreCase(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Whether a returned item corresponds to a requested identifier (item numbers case-insensitive). */
function itemMatchesIdentifier(item: ParsedItem, identifier: ItemIdentifier): boolean {
  switch (identifier.type) {
    case "neweggItemNumber":
      return equalsIgnoreCase(item.itemNumber, identifier.value);
    case "sellerPartNumber":
      return item.sellerPartNumber === identifier.value;
    case "upc":
      return item.upc !== undefined
        ? item.upc === identifier.value
        : item.sellerPartNumber === identifier.value ||
            equalsIgnoreCase(item.itemNumber, identifier.value);
  }
}

function distinctIdentifiers(updates: NormalizedInventoryUpdate[]): ItemIdentifier[] {
  const seen = new Set<string>();
  const out: ItemIdentifier[] = [];
  for (const update of updates) {
    const key = JSON.stringify([update.identifier.type, update.identifier.value]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(update.identifier);
  }
  return out;
}

/** Inventory API: reads (getItem/getMany), preview, and writes (updateItem/updateMany). */
export class InventoryApiImpl implements InventoryApi {
  readonly #http: NeweggHttpClient;
  readonly #feeds: FeedsApiImpl;

  constructor(http: NeweggHttpClient, feeds: FeedsApiImpl) {
    this.#http = http;
    this.#feeds = feeds;
  }

  get #config() {
    return this.#http.config;
  }

  #snapshot(
    parsed: ParsedItem,
    correlationId: string,
    rateLimit: InventoryItemSnapshot["rateLimit"],
    raw: unknown,
  ): InventoryItemSnapshot {
    return {
      marketplace: this.#config.marketplace,
      itemNumber: parsed.itemNumber,
      sellerPartNumber: parsed.sellerPartNumber,
      condition: parsed.condition,
      active: parsed.active,
      totalAvailableQuantity: parsed.totalAvailableQuantity,
      warehouses: parsed.warehouses,
      correlationId,
      rateLimit,
      raw,
    };
  }

  async getItem(input: GetItemInput, options: RequestOptions = {}): Promise<InventoryItemSnapshot> {
    const validated = validateGetItemInput(input);
    const correlationId = options.correlationId ?? randomUUID();
    const warehouses = this.#config.marketplace === "us" ? validated.warehouses : undefined;
    const spec = this.#http.adapter.getItemRequest(validated.identifier, warehouses);
    const result = await this.#http.request(spec, {
      operation: Operation.GetItem,
      correlationId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      rateLimitKey: rateLimitKey(
        this.#config.marketplace,
        this.#config.sellerId,
        Operation.GetItem,
      ),
    });
    const parsed = this.#http.adapter.parseItem(result.json);
    if (!parsed) {
      throw new NeweggApiError("Newegg returned no inventory for the requested item.", {
        correlationId,
        httpStatus: result.status,
      });
    }
    return this.#snapshot(
      parsed,
      correlationId,
      result.rateLimit,
      options.includeRaw ? result.json : undefined,
    );
  }

  async tryGetItem(
    input: GetItemInput,
    options: RequestOptions = {},
  ): Promise<InventoryItemSnapshot | undefined> {
    try {
      return await this.getItem(input, options);
    } catch (err) {
      if (
        err instanceof NeweggApiError &&
        err.neweggErrorCode !== undefined &&
        UNKNOWN_ITEM_ERROR_CODES.has(err.neweggErrorCode)
      ) {
        return undefined;
      }
      throw err;
    }
  }

  async getMany(
    input: GetManyInput,
    options: RequestOptions = {},
  ): Promise<InventoryBatchSnapshot> {
    const validated = validateGetManyInput(input);
    const correlationId = options.correlationId ?? randomUUID();
    const { marketplace } = this.#config;
    if (validated.identifiers.length === 0) {
      return {
        marketplace,
        items: [],
        bySellerPartNumber: new Map<string, InventoryItemSnapshot>(),
        byItemNumber: new Map<string, InventoryItemSnapshot>(),
        missingIdentifiers: [],
        totalCount: 0,
        correlationId,
        raw: options.includeRaw ? [] : undefined,
      };
    }
    const warehouses = marketplace === "us" ? validated.warehouses : undefined;

    const byType = new Map<ItemIdentifier["type"], ItemIdentifier[]>();
    for (const identifier of validated.identifiers) {
      const group = byType.get(identifier.type) ?? [];
      group.push(identifier);
      byType.set(identifier.type, group);
    }

    const items: InventoryItemSnapshot[] = [];
    const parsedItems: ParsedItem[] = [];
    const rawResponses: unknown[] = [];
    let rateLimit: InventoryBatchSnapshot["rateLimit"];

    for (const [type, identifiers] of byType) {
      const typeCode = identifierTypeCode(type);
      const valueChunks = chunk(
        identifiers.map((identifier) => identifier.value),
        GET_BATCH_INVENTORY_MAX_VALUES,
      );
      for (const values of valueChunks) {
        const spec = this.#http.adapter.getManyRequest(typeCode, values, warehouses);
        const result = await this.#http.request(spec, {
          operation: Operation.GetMany,
          correlationId,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          rateLimitKey: rateLimitKey(marketplace, this.#config.sellerId, Operation.GetMany),
        });
        const parsed = this.#http.adapter.parseBatch(result.json);
        for (const item of parsed.items) {
          parsedItems.push(item);
          items.push(this.#snapshot(item, correlationId, undefined, undefined));
        }
        rateLimit = result.rateLimit ?? rateLimit;
        if (options.includeRaw) rawResponses.push(result.json);
      }
    }

    const missingIdentifiers = validated.identifiers.filter(
      (identifier) => !parsedItems.some((item) => itemMatchesIdentifier(item, identifier)),
    );

    // Newegg returns batch items in its own order; give callers key-based lookups so they
    // never have to rely on `items` position or re-index by hand.
    const bySellerPartNumber = new Map<string, InventoryItemSnapshot>();
    const byItemNumber = new Map<string, InventoryItemSnapshot>();
    for (const snap of items) {
      if (snap.sellerPartNumber !== undefined) bySellerPartNumber.set(snap.sellerPartNumber, snap);
      if (snap.itemNumber !== undefined) byItemNumber.set(snap.itemNumber, snap);
    }

    return {
      marketplace,
      items,
      bySellerPartNumber,
      byItemNumber,
      missingIdentifiers,
      totalCount: items.length,
      correlationId,
      rateLimit,
      raw: options.includeRaw ? rawResponses : undefined,
    };
  }

  async previewUpdate(
    updatesInput: InventoryUpdate | InventoryUpdate[],
    options: PreviewOptions = {},
  ): Promise<InventoryUpdatePreview> {
    const updates = Array.isArray(updatesInput) ? updatesInput : [updatesInput];
    const { marketplace, autoFeedThreshold, maxQuantity } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const normalized = validateInventoryUpdates(updates, { marketplace, maxQuantity });
    const dedup = dedupeUpdates(marketplace, normalized);
    const decision = decideStrategy(dedup.deduped, {
      strategy: options.strategy ?? "auto",
      autoFeedThreshold,
    });
    const warnings = [
      ...decision.warnings,
      ...warehouseIgnoredWarnings(marketplace, dedup.deduped),
    ];

    let currentInventory: InventoryItemSnapshot[] | undefined;
    if (options.includeCurrentInventory) {
      const batch = await this.getMany(
        { identifiers: distinctIdentifiers(dedup.deduped) },
        { correlationId, signal: options.signal, timeoutMs: options.timeoutMs },
      );
      currentInventory = batch.items;
    }

    return {
      marketplace,
      strategy: decision.resolved,
      normalizedUpdates: dedup.deduped,
      deduplicated: dedup.report,
      plannedFeedCount: decision.plannedFeedCount,
      zeroQuantityCount: countZeroQuantity(dedup.deduped),
      warnings,
      currentInventory,
      correlationId,
    };
  }

  async updateItem(
    update: InventoryUpdate,
    options: UpdateOptions = {},
  ): Promise<InventoryUpdateResult> {
    return this.#executeUpdate([update], { ...options, strategy: "direct", concurrency: 1 });
  }

  async updateMany(
    updates: InventoryUpdate[],
    options: UpdateManyOptions = {},
  ): Promise<InventoryUpdateResult> {
    return this.#executeUpdate(updates, options);
  }

  #outcome(
    update: NormalizedInventoryUpdate,
    status: ItemOutcomeStatus,
    errorCode?: string,
    message?: string,
  ): ItemOutcome {
    return {
      inputIndex: update.inputIndex,
      sellerPartNumber:
        update.identifier.type === "sellerPartNumber" ? update.identifier.value : undefined,
      warehouseLocation: update.warehouseLocation,
      quantity: update.quantity,
      status,
      errorCode,
      message,
    };
  }

  async #executeUpdate(
    updates: InventoryUpdate[],
    options: UpdateManyOptions,
  ): Promise<InventoryUpdateResult> {
    const { marketplace, autoFeedThreshold, maxQuantity } = this.#config;
    const correlationId = options.correlationId ?? randomUUID();
    const operationId = randomUUID();

    const normalized = validateInventoryUpdates(updates, { marketplace, maxQuantity });
    const dedup = dedupeUpdates(marketplace, normalized);
    if (dedup.deduped.length === 0) {
      return {
        operationId,
        correlationId,
        marketplace,
        strategy: "direct",
        submittedItemCount: 0,
        acceptedItemCount: 0,
        failedItemCount: 0,
        deduplicatedItemCount: dedup.deduplicatedItemCount,
        items: [],
        warnings: [],
      };
    }

    const decision = decideStrategy(dedup.deduped, {
      strategy: options.strategy ?? "auto",
      autoFeedThreshold,
    });
    const warnings = [
      ...decision.warnings,
      ...warehouseIgnoredWarnings(marketplace, dedup.deduped),
    ];
    const concurrency = options.concurrency ?? DEFAULT_DIRECT_CONCURRENCY;

    const outcomes: ItemOutcome[] = [];
    let rateLimit: InventoryUpdateResult["rateLimit"];
    let feedJobs: FeedJobSummary[] | undefined;

    if (decision.direct.length > 0) {
      const direct = await this.#runDirect(decision.direct, options, concurrency, correlationId);
      outcomes.push(...direct.outcomes);
      rateLimit = direct.rateLimit ?? rateLimit;
    }

    if (decision.feed.length > 0) {
      const feed = await this.#runFeed(decision.feed, options, correlationId);
      outcomes.push(...feed.outcomes);
      feedJobs = feed.feedJobs;
      warnings.push(...feed.warnings);
      rateLimit = feed.rateLimit ?? rateLimit;
    }

    outcomes.sort((a, b) => a.inputIndex - b.inputIndex);
    const failedItemCount = outcomes.filter((outcome) => outcome.status === "failed").length;
    const acceptedItemCount = outcomes.filter(
      (outcome) =>
        outcome.status === "succeeded" ||
        outcome.status === "submitted" ||
        outcome.status === "warning",
    ).length;

    if (failedItemCount > 0) {
      this.#config.logger.warn(LogEvent.PartialFailure, {
        correlationId,
        operation: "inventory.updateMany",
        marketplace,
        sellerIdHash: this.#http.sellerIdHash,
        failedItemCount,
      });
    }

    return {
      operationId,
      correlationId,
      marketplace,
      strategy: decision.resolved,
      submittedItemCount: decision.direct.length + decision.feed.length,
      acceptedItemCount,
      failedItemCount,
      deduplicatedItemCount: dedup.deduplicatedItemCount,
      feedJobs,
      items: outcomes,
      warnings,
      rateLimit,
    };
  }

  async #runDirect(
    direct: NormalizedInventoryUpdate[],
    options: UpdateManyOptions,
    concurrency: number,
    correlationId: string,
  ): Promise<{ outcomes: ItemOutcome[]; rateLimit: InventoryUpdateResult["rateLimit"] }> {
    const { marketplace, sellerId } = this.#config;
    const tasks: Array<{ group: DirectUpdateGroup; members: NormalizedInventoryUpdate[] }> = [];

    if (marketplace === "us") {
      const byKey = new Map<
        string,
        { group: DirectUpdateGroup; members: NormalizedInventoryUpdate[] }
      >();
      const order: string[] = [];
      for (const update of direct) {
        const condition =
          update.identifier.type === "upc" ? (update.identifier.condition ?? "") : "";
        const key = JSON.stringify([update.identifier.type, update.identifier.value, condition]);
        let entry = byKey.get(key);
        if (!entry) {
          entry = { group: { identifier: update.identifier, entries: [] }, members: [] };
          byKey.set(key, entry);
          order.push(key);
        }
        entry.group.entries.push({
          warehouseLocation: update.warehouseLocation,
          quantity: update.quantity,
        });
        entry.members.push(update);
      }
      for (const key of order) {
        const entry = byKey.get(key);
        if (entry) tasks.push(entry);
      }
    } else {
      for (const update of direct) {
        tasks.push({
          group: {
            identifier: update.identifier,
            entries: [{ warehouseLocation: update.warehouseLocation, quantity: update.quantity }],
          },
          members: [update],
        });
      }
    }

    let rateLimit: InventoryUpdateResult["rateLimit"];
    const results = await mapWithConcurrency(tasks, concurrency, async (task) => {
      const spec = this.#http.adapter.directUpdateRequest(task.group);
      try {
        const result = await this.#http.request(spec, {
          operation: Operation.UpdateDirect,
          correlationId,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          rateLimitKey: rateLimitKey(marketplace, sellerId, Operation.UpdateDirect),
        });
        rateLimit = result.rateLimit ?? rateLimit;
        return task.members.map((member) => this.#outcome(member, "succeeded"));
      } catch (err) {
        if (isAbortError(err)) throw err;
        const error =
          err instanceof NeweggError
            ? err
            : new NeweggApiError("Direct inventory update failed.", { correlationId });
        return task.members.map((member) =>
          this.#outcome(member, "failed", error.neweggErrorCode, error.message),
        );
      }
    });

    return { outcomes: results.flat(), rateLimit };
  }

  async #runFeed(
    feed: NormalizedInventoryUpdate[],
    options: UpdateManyOptions,
    correlationId: string,
  ): Promise<{
    outcomes: ItemOutcome[];
    feedJobs: FeedJobSummary[];
    warnings: string[];
    rateLimit: InventoryUpdateResult["rateLimit"];
  }> {
    // Hand plain InventoryUpdates to the feed API: `feed` items are NormalizedInventoryUpdate
    // (they carry `inputIndex`), which must never reach the wire envelope. `map` preserves
    // order and count, so submission.itemAssignments[k].inputIndex still indexes into `feed`.
    const submission = await this.#feeds.submitInventoryFeed(
      { items: feed.map(({ inputIndex: _inputIndex, ...update }) => update) },
      { correlationId, signal: options.signal, timeoutMs: options.timeoutMs },
    );

    const itemsByRequest = new Map<string, NormalizedInventoryUpdate[]>();
    const outcomeByInput = new Map<number, ItemOutcome>();
    for (const assignment of submission.itemAssignments) {
      const item = feed[assignment.inputIndex];
      if (!item) continue;
      const group = itemsByRequest.get(assignment.requestId) ?? [];
      group.push(item);
      itemsByRequest.set(assignment.requestId, group);
      outcomeByInput.set(item.inputIndex, this.#outcome(item, "submitted"));
    }

    const feedJobs: FeedJobSummary[] = submission.feeds.map((job) => ({
      requestId: job.requestId,
      status: job.status,
      itemCount: job.itemCount,
    }));

    if (options.waitForFeedCompletion) {
      for (let i = 0; i < submission.feeds.length; i++) {
        const job = submission.feeds[i];
        if (!job) continue;
        const items = itemsByRequest.get(job.requestId) ?? [];
        const waitOutcome = await this.#feeds.waitForResult(job.requestId, {
          ...(options.wait ?? {}),
          correlationId,
          signal: options.signal,
        });
        if (waitOutcome.outcome === "finished") {
          feedJobs[i] = { requestId: job.requestId, status: "FINISHED", itemCount: job.itemCount };
          this.#foldFeedResult(waitOutcome.result, items, outcomeByInput);
        } else if (waitOutcome.outcome === "cancelled") {
          feedJobs[i] = { requestId: job.requestId, status: "CANCELLED", itemCount: job.itemCount };
          for (const item of items) {
            outcomeByInput.set(
              item.inputIndex,
              this.#outcome(item, "failed", "CANCELLED", "Feed was cancelled by Newegg."),
            );
          }
        } else {
          feedJobs[i] = {
            requestId: job.requestId,
            status: waitOutcome.lastStatus,
            itemCount: job.itemCount,
          };
          for (const item of items) {
            outcomeByInput.set(
              item.inputIndex,
              this.#outcome(
                item,
                "submitted",
                undefined,
                "Feed processing did not finish before the wait timeout.",
              ),
            );
          }
        }
      }
    }

    return {
      outcomes: [...outcomeByInput.values()],
      feedJobs,
      warnings: [...submission.warnings],
      rateLimit: submission.rateLimit,
    };
  }

  #foldFeedResult(
    result: FeedResult,
    items: NormalizedInventoryUpdate[],
    outcomeByInput: Map<number, ItemOutcome>,
  ): void {
    for (const item of items) {
      outcomeByInput.set(item.inputIndex, this.#outcome(item, "succeeded"));
    }
    for (const record of result.records) {
      if (record.status === "succeeded") continue;
      const spn = record.sellerPartNumber;
      if (!spn) continue;
      const warehouse = record.additionalInfo.WarehouseLocation;
      const message = record.messages.join("; ") || undefined;
      for (const item of items) {
        if (item.identifier.type !== "sellerPartNumber" || item.identifier.value !== spn) continue;
        if (
          this.#config.marketplace === "us" &&
          warehouse !== undefined &&
          item.warehouseLocation !== warehouse
        ) {
          continue;
        }
        outcomeByInput.set(item.inputIndex, this.#outcome(item, record.status, undefined, message));
      }
    }
  }
}
