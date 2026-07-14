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
  /** Read-only order lookups (list / get / status). Never mutates. */
  readonly orders: OrdersApi;
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
// orders (read-only)
// ----------------------------------------------------------------------------

/**
 * Normalized order status. Newegg wire codes 0–5 map to these; an unrecognized code becomes
 * `"unknown"` (forward-compatible — Newegg may add codes) rather than throwing. See
 * `newegg-api-contracts.md` §10.
 */
export type OrderStatus =
  | "unshipped"
  | "partiallyShipped"
  | "shipped"
  | "invoiced"
  | "voided"
  | "paymentPending"
  | "unknown";

/** Line-item status — a DIFFERENT scale from {@link OrderStatus} (wire codes 1/2/3). */
export type OrderItemStatus = "unshipped" | "shipped" | "cancelled" | "unknown";

/** Order sales channel (wire codes 0–3). */
export type OrderSalesChannel = "newegg" | "multiChannel" | "replacement" | "nws" | "unknown";

/** Who ships the order — `FulfillmentOption` 0 (seller) / 1 (Newegg / SBN). */
export type OrderFulfillment = "seller" | "newegg";

/** `Type` request filter: 0 All / 1 SBN / 2 SBS / 3 Multi-Channel / 4 NWS. */
export type OrderTypeFilter = "all" | "sbn" | "sbs" | "multiChannel" | "nws";

/** `PremierOrder` request filter: 0 All / 1 Premier only / 2 No Premier. */
export type PremierOrderFilter = "all" | "premierOnly" | "noPremier";

/** Criteria for {@link OrdersApi.list}. Every field is optional; omit all to match all orders. */
export interface ListOrdersInput {
  /** Direct lookup: when set, Newegg ignores every other criterion (`OrderNumberList`). */
  orderNumbers?: Array<string | number>;
  /** Seller order numbers / SBN references (`SellerOrderNumberList`). */
  sellerOrderNumbers?: string[];
  /** Filter by a single order status (`Status`). */
  status?: OrderStatus;
  /** Filter by fulfillment/channel type (`Type`). Default `"all"` on the wire. */
  type?: OrderTypeFilter;
  /** `false` excludes already-downloaded orders (`OrderDownloaded=1`). Default includes all. */
  includeDownloaded?: boolean;
  /** Premier-order filter (`PremierOrder`). */
  premierOrder?: PremierOrderFilter;
  /** Lower bound on order date. `Date` is rendered as Pacific Time; a string is sent verbatim. */
  dateFrom?: Date | string;
  /** Upper bound on order date (see {@link ListOrdersInput.dateFrom}). */
  dateTo?: Date | string;
  /** ISO 3-digit country code (`CountryCode`). */
  countryCode?: string;
  /** 1-based page (`PageIndex`, default 1). */
  page?: number;
  /** Page size (`PageSize`, max 100, default 100). */
  pageSize?: number;
}

export interface ShipToAddress {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  stateCode?: string;
  zipCode?: string;
  countryCode?: string;
}

export interface OrderCustomer {
  name?: string;
  phoneNumber?: string;
  /** Masked Newegg relay address (`…@marketplace.newegg.com`), never the buyer's real email. */
  emailAddress?: string;
  shipTo?: ShipToAddress;
}

/** Money breakdown; each value is a decimal in the order's {@link Order.currencyCode}. */
export interface OrderAmounts {
  itemAmount?: number;
  shippingAmount?: number;
  discountAmount?: number;
  refundAmount?: number;
  salesTax?: number;
  vatTotal?: number;
  dutyTotal?: number;
  recyclingFee?: number;
  /** `OrderTotalAmount`. */
  total?: number;
}

export interface OrderItem {
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  mfrPartNumber?: string;
  upc?: string;
  description?: string;
  orderedQty?: number;
  shippedQty?: number;
  unitPrice?: number;
  /** `ExtendUnitPrice` — unit price × ordered quantity. */
  extendedUnitPrice?: number;
  extendedShippingCharge?: number;
  status: OrderItemStatus;
  statusDescription?: string;
  buyerRequestedCancel?: boolean;
}

export interface OrderPackage {
  shipCarrier?: string;
  shipService?: string;
  trackingNumber?: string;
  shipDate?: { raw: string; iso?: string };
  sellerPartNumber?: string;
  mfrPartNumber?: string;
  shippedQty?: number;
  memo?: string;
}

/** A fully normalized order from Get Order Information (`newegg-api-contracts.md` §10.1). */
export interface Order {
  /** Always a string here (the wire sends it as a number or string). */
  orderNumber: string;
  sellerOrderNumber?: string;
  invoiceNumber?: string;
  status: OrderStatus;
  statusDescription?: string;
  /** `OrderDownloaded`. */
  downloaded?: boolean;
  orderDate?: { raw: string; iso?: string };
  autoVoidTime?: { raw: string; iso?: string };
  isAutoVoid?: boolean;
  salesChannel?: OrderSalesChannel;
  fulfillment?: OrderFulfillment;
  currencyCode?: string;
  customer?: OrderCustomer;
  shipService?: string;
  signatureRequired?: boolean;
  onTimeShipDueDate?: { raw: string; iso?: string };
  deliverDueDate?: { raw: string; iso?: string };
  amounts: OrderAmounts;
  /** `OrderQty`. */
  quantity?: number;
  items: OrderItem[];
  packages: OrderPackage[];
}

/** One page of {@link OrdersApi.list} results; paginate via {@link OrdersPage.totalPageCount}. */
export interface OrdersPage {
  marketplace: NeweggMarketplace;
  orders: Order[];
  /** Echoed 1-based `PageIndex`. */
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Lightweight status from Get Order Status (`newegg-api-contracts.md` §10.2). */
export interface OrderStatusSnapshot {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  status: OrderStatus;
  /** Newegg's camel-case `OrderStatusName` label (e.g. `"PartiallyShipped"`). */
  statusName?: string;
  downloaded?: boolean;
  salesChannel?: OrderSalesChannel;
  fulfillment?: OrderFulfillment;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** One item within a shipment package for {@link OrdersApi.ship}. */
export interface ShipPackageItem {
  sellerPartNumber: string;
  /** Units of this item shipped in this package (> 0). */
  shippedQty: number;
  neweggItemNumber?: string;
}

/** One package in a shipment; every ordered unit of an item must be covered across packages. */
export interface ShipPackage {
  trackingNumber: string;
  /** A value from Newegg's Integrated Carrier List. */
  shipCarrier: string;
  shipService: string;
  items: ShipPackageItem[];
}

/** Input to {@link OrdersApi.ship} (Ship Order, `Action` = 2; contracts §11.1). */
export interface ShipOrderInput {
  orderNumber: string | number;
  packages: ShipPackage[];
}

/** Per-package outcome in a {@link ShipOrderResult}. */
export interface ShipPackageResult {
  trackingNumber?: string;
  shipDate?: { raw: string; iso?: string };
  /** Newegg's per-package success flag — the AUTHORITATIVE outcome (envelope `IsSuccess` is not). */
  processStatus: boolean;
  processResult?: string;
  items: Array<{ sellerPartNumber?: string; neweggItemNumber?: string; shippedQty?: number }>;
}

/** Result of {@link OrdersApi.ship}. */
export interface ShipOrderResult {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  /** New order status normalized from Newegg's string label (`Shipped` / `PartiallyShipped`). */
  status: OrderStatus;
  /** Raw status label as returned (e.g. `"PartiallyShipped"`). */
  statusLabel?: string;
  totalPackageCount: number;
  successCount: number;
  failCount: number;
  packages: ShipPackageResult[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Cancel reason for {@link OrdersApi.cancel} (→ codes 24 / 72 / 73 / 74; §11.2). */
export type CancelReason = "outOfStock" | "customerRequested" | "priceError" | "unableToFulfill";

/** Input to {@link OrdersApi.cancel} (Cancel Order, `Action` = 1). */
export interface CancelOrderInput {
  orderNumber: string | number;
  reason: CancelReason;
}

/** Cancel outcome: `void` = cancelled; `processing` = SBN cancellation accepted, result pending. */
export type CancelOrderOutcome = "void" | "processing" | "unknown";

/** Result of {@link OrdersApi.cancel}. */
export interface CancelOrderResult {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  outcome: CancelOrderOutcome;
  /** Raw outcome label as returned (e.g. `"Void"`). */
  outcomeLabel?: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Input to {@link OrdersApi.confirmDownload} (Order Confirmation / mark-downloaded; §11.3). */
export interface ConfirmOrdersInput {
  orderNumbers: Array<string | number>;
  /** Optional eligible seller-account email (`IssueUser`). */
  issueUser?: string;
}

/** Result of {@link OrdersApi.confirmDownload}. */
export interface ConfirmOrdersResult {
  marketplace: NeweggMarketplace;
  /** The order numbers Newegg echoed as marked-downloaded. */
  orderNumbers: string[];
  requestDate?: { raw: string; iso?: string };
  responseDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Input to {@link OrdersApi.removeItems} (Remove Item / KillItem; §11.4). */
export interface RemoveOrderItemsInput {
  orderNumber: string | number;
  /** Seller part numbers to remove from the order (must be unique). */
  sellerPartNumbers: string[];
  /** Optional reason (`Memo`). */
  memo?: string;
  /** Optional eligible seller-account email (`IssueUser`). */
  issueUser?: string;
}

/** Result of {@link OrdersApi.removeItems}. */
export interface RemoveOrderItemsResult {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  /** Seller part numbers Newegg echoed as removed. */
  removedSellerPartNumbers: string[];
  /** `null`/absent on success; a detailed error description when the operation failed. */
  memo?: string;
  requestDate?: { raw: string; iso?: string };
  responseDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface OrdersApi {
  /** Search orders by criteria (single page). Omit `input` to match all orders. */
  list(input?: ListOrdersInput, options?: RequestOptions): Promise<OrdersPage>;
  /**
   * Fetch one order's full detail by order number (Get Order Information with a single
   * `OrderNumber`). Throws {@link NeweggError} when no such order exists for this seller.
   */
  get(orderNumber: string | number, options?: RequestOptions): Promise<Order>;
  /** Like {@link OrdersApi.get} but resolves to `undefined` when the order is not found. */
  tryGet(orderNumber: string | number, options?: RequestOptions): Promise<Order | undefined>;
  /**
   * Lightweight status-only lookup (Get Order Status endpoint). Throws when the order is
   * unknown or not this seller's (`SO003`).
   */
  getStatus(orderNumber: string | number, options?: RequestOptions): Promise<OrderStatusSnapshot>;
  /** Like {@link OrdersApi.getStatus} but resolves to `undefined` on `SO003` (not found). */
  tryGetStatus(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<OrderStatusSnapshot | undefined>;
  /**
   * Ship one order in one or more packages (Ship Order, `Action` = 2 — a WRITE via PUT to the
   * order-status endpoint). Newegg's envelope `IsSuccess` is always `true`, so the real outcome
   * is {@link ShipOrderResult.failCount} + per-package `processStatus`. NOT idempotent: an
   * ambiguous transport failure throws {@link IndeterminateOrderWriteError} instead of retrying.
   */
  ship(input: ShipOrderInput, options?: RequestOptions): Promise<ShipOrderResult>;
  /**
   * Cancel (void) an unshipped order with a reason (Cancel Order, `Action` = 1). NOT idempotent
   * (see {@link OrdersApi.ship}); an SBN order may come back `processing` (poll separately).
   */
  cancel(input: CancelOrderInput, options?: RequestOptions): Promise<CancelOrderResult>;
  /**
   * Mark one or more orders as downloaded/acknowledged (Order Confirmation). Effectively
   * idempotent, but still a mutation.
   */
  confirmDownload(
    input: ConfirmOrdersInput,
    options?: RequestOptions,
  ): Promise<ConfirmOrdersResult>;
  /**
   * Remove one or more line items from an unshipped order by seller part number (KillItem). Not
   * allowed on SBN orders. NOT idempotent (see {@link OrdersApi.ship}).
   */
  removeItems(
    input: RemoveOrderItemsInput,
    options?: RequestOptions,
  ): Promise<RemoveOrderItemsResult>;
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
