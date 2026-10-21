/** Inventory read and write types. Re-exported from `../types.ts`. */

import type {
  InventoryUpdate,
  ItemCondition,
  ItemIdentifier,
  NeweggMarketplace,
  RequestOptions,
} from "./common.js";
import type { FeedRequestStatus, WaitForResultOptions } from "./feeds.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// inventory reads
// ----------------------------------------------------------------------------
export interface GetItemInput {
  identifier: ItemIdentifier;
  /** US only. */
  warehouses?: string[];
}
export interface GetManyInput {
  identifiers: ItemIdentifier[];
  /** US only. */
  warehouses?: string[];
}

export interface WarehouseInventory {
  /**
   * ISO alpha-3 country (US) or Newegg warehouse/SBS code (B2B/CAN breakdown). B2B/CAN flat
   * inventory responses carry no per-warehouse breakdown, so the SDK reports a single bucket
   * with the synthetic location `"default"` — that string is an SDK convention, not a Newegg
   * warehouse code.
   */
  location: string;
  quantity: number;
  fulfillment: "seller" | "newegg";
}
export interface InventoryItemSnapshot {
  marketplace: NeweggMarketplace;
  itemNumber?: string;
  sellerPartNumber?: string;
  condition?: ItemCondition;
  /** B2B/CAN only. */
  active?: boolean;
  totalAvailableQuantity: number;
  warehouses: WarehouseInventory[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  /** Only when `includeRaw`. */
  raw?: unknown;
}
export interface InventoryBatchSnapshot {
  marketplace: NeweggMarketplace;
  items: InventoryItemSnapshot[];
  /**
   * Look up a returned item by its exact seller part number. Newegg returns batch items in
   * its own order, not the requested order, so resolve results by key rather than by `items`
   * position. A requested identifier absent here appears in {@link missingIdentifiers}.
   */
  bySellerPartNumber: ReadonlyMap<string, InventoryItemSnapshot>;
  /** Look up a returned item by its Newegg item number (as Newegg returned it). */
  byItemNumber: ReadonlyMap<string, InventoryItemSnapshot>;
  /** Requested but not returned by Newegg. */
  missingIdentifiers: ItemIdentifier[];
  totalCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

// ----------------------------------------------------------------------------
// inventory writes
// ----------------------------------------------------------------------------
export type InventoryUpdateStrategy = "direct" | "feed" | "auto";

export type UpdateOptions = RequestOptions;
export interface UpdateManyOptions extends RequestOptions {
  /** Default "auto". */
  strategy?: InventoryUpdateStrategy;
  /** Default false. */
  waitForFeedCompletion?: boolean;
  /** Polling knobs when waiting. */
  wait?: WaitForResultOptions;
  /** Direct-update concurrency, default 4. */
  concurrency?: number;
}
export interface PreviewOptions extends RequestOptions {
  strategy?: InventoryUpdateStrategy;
  /** Performs reads; still zero writes. */
  includeCurrentInventory?: boolean;
}

export interface NormalizedInventoryUpdate extends InventoryUpdate {
  /** Index in the caller's original array. */
  inputIndex: number;
}
export interface InventoryUpdatePreview {
  marketplace: NeweggMarketplace;
  strategy: "direct" | "feed" | "mixed";
  /** Post-validation, post-dedup (last-write-wins). */
  normalizedUpdates: NormalizedInventoryUpdate[];
  deduplicated: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }>;
  /** 0 when direct. */
  plannedFeedCount: number;
  zeroQuantityCount: number;
  warnings: string[];
  /** When `includeCurrentInventory`. */
  currentInventory?: InventoryItemSnapshot[];
  correlationId: string;
}

export type ItemOutcomeStatus =
  "planned" | "submitted" | "succeeded" | "warning" | "failed" | "unknown";
export interface ItemOutcome {
  inputIndex: number;
  sellerPartNumber?: string;
  warehouseLocation?: string;
  quantity: number;
  status: ItemOutcomeStatus;
  errorCode?: string;
  message?: string;
}
export interface FeedJobSummary {
  requestId: string;
  status: FeedRequestStatus;
  itemCount: number;
}
export interface InventoryUpdateResult {
  operationId: string;
  correlationId: string;
  marketplace: NeweggMarketplace;
  strategy: "direct" | "feed" | "mixed";
  submittedItemCount: number;
  acceptedItemCount: number;
  failedItemCount: number;
  deduplicatedItemCount: number;
  feedJobs?: FeedJobSummary[];
  items: ItemOutcome[];
  warnings: string[];
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface InventoryApi {
  getItem(input: GetItemInput, options?: RequestOptions): Promise<InventoryItemSnapshot>;
  /**
   * Like {@link getItem} but resolves to `undefined` instead of throwing when Newegg reports
   * the item is unknown (`CT026` on SKU/item-number reads; `CT010` on UPC reads — proven
   * live). Every other failure — authentication, authorization, rate limit, malformed body,
   * any other API error — still throws. Mirrors how {@link getMany} reports unknown
   * identifiers via `missingIdentifiers`.
   */
  tryGetItem(
    input: GetItemInput,
    options?: RequestOptions,
  ): Promise<InventoryItemSnapshot | undefined>;
  getMany(input: GetManyInput, options?: RequestOptions): Promise<InventoryBatchSnapshot>;
  previewUpdate(
    updates: InventoryUpdate | InventoryUpdate[],
    options?: PreviewOptions,
  ): Promise<InventoryUpdatePreview>;
  /**
   * WARNING (proven live): when the target item is DEACTIVATED, Newegg accepts the
   * update and reports it "succeeded", then silently disregards it — the stored
   * quantity does not change. A "succeeded" outcome is therefore only trustworthy for
   * active items; check `active` on a {@link getItem} snapshot first, or use the
   * ITEM_DATA v2 feed (`listings.create` resubmission), which does persist fields on
   * deactivated items.
   */
  updateItem(update: InventoryUpdate, options?: UpdateOptions): Promise<InventoryUpdateResult>;
  /** See the deactivated-item warning on {@link updateItem} — it applies per item here. */
  updateMany(
    updates: InventoryUpdate[],
    options?: UpdateManyOptions,
  ): Promise<InventoryUpdateResult>;
}
