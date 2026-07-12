/**
 * Public type surface for `@devino/newegg-marketplace-sdk`.
 *
 * This module holds every exported interface/type alias from the binding public API
 * contract (see `docs/research/sdk-public-api.md`). Error classes live in `errors/`,
 * store implementations in `rate-limit/` and `operation-store/`, and the factory in
 * `client/`. Everything here is re-exported from the package root.
 */

// ----------------------------------------------------------------------------
// marketplaces & service domains
// ----------------------------------------------------------------------------
export type NeweggMarketplace = "us" | "b2b" | "ca";

export type NeweggServiceDomain =
  | "contentmgmt"
  | "ordermgmt"
  | "datafeedmgmt"
  | "servicemgmt"
  | "reportmgmt"
  | "sellermgmt"
  | "sbnmgmt"
  | "shippingservice";

// ----------------------------------------------------------------------------
// client configuration
// ----------------------------------------------------------------------------
export interface NeweggClientConfig {
  sellerId: string;
  apiKey: string;
  secretKey: string;
  marketplace: NeweggMarketplace;
  /** Trusted-config-only override (tests, proxies). Never exposed via MCP. Must end in `/`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default `30_000`. */
  timeoutMs?: number;
  /** Default `newegg-marketplace-sdk/<version> node/<version>`. */
  userAgent?: string;
  retry?: RetryOptions;
  logger?: NeweggLogger;
  fetch?: typeof globalThis.fetch;
  rateLimitStore?: RateLimitStore;
  operationStore?: OperationStore;
  strategy?: {
    /**
     * `updateMany` "auto" switches to feeds at more than this many post-dedup items.
     * Default 8. SDK policy, not a Newegg rule.
     */
    autoFeedThreshold?: number;
  };
  /** Optional app-level quantity ceiling; the SDK never clamps silently — a violation throws {@link NeweggValidationError}. */
  maxQuantity?: number;
}

export interface NeweggClient {
  readonly marketplace: NeweggMarketplace;
  readonly inventory: InventoryApi;
  readonly feeds: FeedsApi;
  readonly service: ServiceApi;
  /**
   * Read-only, fail-fast credential preflight. Issues a single service-status GET and
   * throws immediately when the credentials are wrong or unauthorized
   * ({@link NeweggAuthenticationError} on 401, {@link NeweggAuthorizationError} on 403).
   * Resolves on success, so callers verify once at startup and then treat every later call
   * as authenticated. Never mutates anything.
   */
  verifyCredentials(options?: RequestOptions): Promise<CredentialCheck>;
}

/** Result of a successful {@link NeweggClient.verifyCredentials} preflight. */
export interface CredentialCheck {
  readonly ok: true;
  readonly marketplace: NeweggMarketplace;
  /** The service domain that was probed (always `"contentmgmt"`). */
  readonly domain: NeweggServiceDomain;
  /** Whether that domain reported itself available (informational only). */
  readonly serviceAvailable: boolean;
  readonly timestamp?: { raw: string; iso?: string };
  readonly correlationId: string;
}

// ----------------------------------------------------------------------------
// shared request options
// ----------------------------------------------------------------------------
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Auto-generated UUID when omitted. */
  correlationId?: string;
  /** Attach sanitized raw response payload to results (never surfaced via MCP). */
  includeRaw?: boolean;
}

// ----------------------------------------------------------------------------
// identifiers & updates (normalized domain types)
// ----------------------------------------------------------------------------
export type ItemCondition =
  "new" | "refurbished" | "usedLikeNew" | "usedVeryGood" | "usedGood" | "usedAcceptable";

export type ItemIdentifier =
  | { type: "sellerPartNumber"; value: string }
  | { type: "neweggItemNumber"; value: string }
  | { type: "upc"; value: string; condition?: ItemCondition };

export interface InventoryUpdate {
  identifier: ItemIdentifier;
  /** Non-negative safe integer; 0 is valid and meaningful. */
  quantity: number;
  /** ISO 3166-1 alpha-3, uppercase; required for US ops. */
  warehouseLocation?: string;
  fulfillmentOption?: "Seller";
  /** Caller bookkeeping, never sent to Newegg. */
  metadata?: Record<string, string>;
}

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
   * the item is unknown (error code `CT026`). Every other failure — authentication,
   * authorization, rate limit, malformed body, any other API error — still throws. Mirrors how
   * {@link getMany} reports unknown identifiers via `missingIdentifiers`.
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
  updateItem(update: InventoryUpdate, options?: UpdateOptions): Promise<InventoryUpdateResult>;
  updateMany(
    updates: InventoryUpdate[],
    options?: UpdateManyOptions,
  ): Promise<InventoryUpdateResult>;
}

// ----------------------------------------------------------------------------
// feeds
// ----------------------------------------------------------------------------
export type FeedRequestStatus = "SUBMITTED" | "IN_PROGRESS" | "FINISHED" | "CANCELLED" | "UNKNOWN";

export interface SubmitInventoryFeedInput {
  items: InventoryUpdate[];
}
export interface FeedJob {
  requestId: string;
  /** INVENTORY_DATA | INVENTORY_AND_PRICE_DATA */
  requestType: string;
  marketplace: NeweggMarketplace;
  status: FeedRequestStatus;
  itemCount: number;
  chunkIndex: number;
  submittedAt?: { raw: string; iso?: string };
  correlationId: string;
}
export interface FeedSubmission {
  feeds: FeedJob[];
  deduplicatedItemCount: number;
  /** Maps every accepted input item to its feed. */
  itemAssignments: Array<{ inputIndex: number; requestId: string; chunkIndex: number }>;
  warnings: string[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
}

export interface FeedStatusReport {
  requestId: string;
  status: FeedRequestStatus;
  requestType?: string;
  submittedAt?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export type FeedRecordStatus = "succeeded" | "warning" | "failed" | "unknown";
export interface FeedResultRecord {
  sellerPartNumber?: string;
  additionalInfo: Record<string, string>;
  status: FeedRecordStatus;
  messages: string[];
}
export interface FeedResult {
  requestId: string;
  status: Extract<FeedRequestStatus, "FINISHED">;
  summary: { processed: number; succeeded: number; failed: number };
  /** Detailed records (Newegg details failures/warnings). */
  records: FeedResultRecord[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface WaitForResultOptions extends RequestOptions {
  /** Default 5_000. */
  pollingIntervalMs?: number;
  /** Default 60_000 (bounded exponential). */
  maxPollingIntervalMs?: number;
  /** Default 900_000; polling never runs unbounded. */
  timeoutMs?: number;
}
export type FeedWaitOutcome =
  | { outcome: "finished"; result: FeedResult }
  | { outcome: "cancelled"; requestId: string; status: "CANCELLED" }
  | { outcome: "timeout"; requestId: string; lastStatus: FeedRequestStatus; elapsedMs: number };

export interface FeedsApi {
  submitInventoryFeed(
    input: SubmitInventoryFeedInput,
    options?: RequestOptions,
  ): Promise<FeedSubmission>;
  getStatus(requestId: string, options?: RequestOptions): Promise<FeedStatusReport>;
  getResult(requestId: string, options?: RequestOptions): Promise<FeedResult>;
  waitForResult(requestId: string, options?: WaitForResultOptions): Promise<FeedWaitOutcome>;
}

// ----------------------------------------------------------------------------
// service
// ----------------------------------------------------------------------------
export interface ServiceStatus {
  marketplace: NeweggMarketplace;
  domain: NeweggServiceDomain;
  available: boolean;
  timestamp?: { raw: string; iso?: string };
  message?: string;
  correlationId: string;
  raw?: unknown;
}
export interface ServiceApi {
  /** Defaults to the "contentmgmt" domain. */
  getStatus(domain?: NeweggServiceDomain, options?: RequestOptions): Promise<ServiceStatus>;
}

// ----------------------------------------------------------------------------
// rate limiting
// ----------------------------------------------------------------------------
export interface RateLimitInfo {
  requestLimit?: number;
  requestRemaining?: number;
  requestResetAt?: Date;
  recordLimit?: number;
  recordRemaining?: number;
  recordResetAt?: Date;
}
/** Keyed by `${marketplace}:${sellerId}:${operation}`. */
export interface RateLimitStore {
  /** Resolves when the caller may proceed; enforces local budgets (e.g. 10 feeds/min, 100k records/hour). */
  acquire(key: string, req: { recordCost?: number; signal?: AbortSignal }): Promise<void>;
  /** Feed observed server-side headers back into the limiter. */
  observe(key: string, info: RateLimitInfo): void;
  /** Local budget configuration (set once per operation kind by the SDK). */
  configure(key: string, budget: { maxPerMinute?: number; maxRecordsPerHour?: number }): void;
}

// ----------------------------------------------------------------------------
// retry / idempotency
// ----------------------------------------------------------------------------
export interface RetryOptions {
  /** Default 3 (initial + 2 retries). */
  maxAttempts?: number;
  /** Default 250, full-jitter exponential. */
  baseDelayMs?: number;
  /** Default 10_000. */
  maxDelayMs?: number;
}
export interface StoredOperation {
  state: "submitting" | "submitted" | "failed";
  payloadHash: string;
  requestIds?: string[];
  /** ISO timestamp. */
  updatedAt: string;
}
export interface OperationStore {
  get(key: string): Promise<StoredOperation | undefined>;
  put(key: string, op: StoredOperation): Promise<void>;
}

// ----------------------------------------------------------------------------
// logging
// ----------------------------------------------------------------------------
export interface NeweggLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
