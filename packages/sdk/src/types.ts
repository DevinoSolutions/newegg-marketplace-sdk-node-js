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
  /**
   * Replaces the built-in FTP downloader used by the file-style reports
   * (`client.reports.dailyInventory` / `dailyPrice`; contracts §17.5). Newegg answers those
   * reports with an `ftp://user:password@host/file` URL; the default downloader only connects to
   * `*.newegg.com`. A custom downloader receives that URL, which embeds credentials: treat it as
   * a secret and never log it. Mainly for tests and for environments that must proxy FTP.
   */
  reportFileDownloader?: ReportFileDownloader;
}

export interface NeweggClient {
  readonly marketplace: NeweggMarketplace;
  readonly inventory: InventoryApi;
  /**
   * Item pricing: Get Item Price reads (contracts §15) and, WRITE, gated selling-price updates
   * (`update`, §16). `previewUpdate` and the reads never mutate.
   */
  readonly pricing: PricingApi;
  readonly feeds: FeedsApi;
  readonly service: ServiceApi;
  /** Read-only order lookups (list / get / status). Never mutates. */
  readonly orders: OrdersApi;
  /** Read-only RMA lookups (Get RMA Information; contracts §18). Never mutates. */
  readonly rma: RmaApi;
  /**
   * Read-only courtesy refund lookups (information and request status; contracts §18). Never
   * mutates; issuing a courtesy refund is intentionally not implemented.
   */
  readonly refunds: RefundsApi;
  /**
   * Read-only seller / category reference lookups (seller status, industries, subcategory
   * status and properties; contracts §19). Never mutates.
   */
  readonly reference: ReferenceApi;
  /** Read-only catalog resolution via the Item Lookup Report (contracts §12). Never mutates. */
  readonly catalog: CatalogApi;
  /**
   * Read-only async reports (Settlement Summary, Settlement Transaction, Daily Inventory,
   * Daily Price; contracts §17). Report submission creates a report job and mutates nothing.
   */
  readonly reports: ReportsApi;
  /**
   * Existing-item listing creation (contracts §13). WRITE: `create` submits an
   * `ITEM_DATA&v2` data feed that adds seller offers to the account. `previewCreate` is offline.
   */
  readonly listings: ListingsApi;
  /**
   * UNOFFICIAL, read-only reader for the PUBLIC storefront's buy box and competing seller
   * offers (contracts §14). Not part of the seller API — unauthenticated, no SLA, may change
   * without notice. `us`/`ca` only; `b2b` throws {@link UnsupportedMarketplaceOperationError}.
   */
  readonly storefront: StorefrontApi;
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
  /** Newegg.ca: `GSTorHSTAmount`. */
  gstOrHstAmount?: number;
  /** Newegg.ca: `PSTorQSTAmount`. */
  pstOrQstAmount?: number;
  /** Newegg.ca: `EHFAmount` (eco handling fee; seen live on the Order List report). */
  ehfAmount?: number;
  /** `OrderTotalAmount`. */
  total?: number;
}

/** One line of a package (`PackageInfo.ItemInfoList.ItemInfo`; seen live on the Order List report). */
export interface OrderPackageItem {
  sellerPartNumber?: string;
  mfrPartNumber?: string;
  shippedQty?: number;
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
  /** The package's lines, when Newegg nests them as `ItemInfoList` instead of flat fields. */
  items?: OrderPackageItem[];
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
// catalog (item lookup / resolution; contracts §12)
// ----------------------------------------------------------------------------
/** One product to resolve against Newegg's catalog. Exactly one identifier family per entry. */
export type CatalogLookupInput =
  /** Already a Newegg item number — echoed back as resolved without any API call. */
  | { neweggItemNumber: string }
  | { upc: string; condition?: ItemCondition; packsOrSets?: number }
  | {
      manufacturer: string;
      manufacturerPartNumber: string;
      condition?: ItemCondition;
      packsOrSets?: number;
    };

/** A catalog item Newegg reported as matching a lookup criterion. */
export interface CatalogMatch {
  neweggItemNumber: string;
  upc?: string;
  condition?: ItemCondition;
  packsOrSets?: number;
  manufacturer?: string;
  manufacturerPartNumber?: string;
  /** Newegg's catalog title — use it to confirm the match is the intended product. */
  websiteShortTitle?: string;
}

/** Resolution outcome for one input: the input echoed back plus its catalog matches. */
export interface CatalogResolution {
  input: CatalogLookupInput;
  found: boolean;
  /** Ranked best-first: rows with a known `condition` precede condition-less pseudo-rows
   * (the lookup report emits refurb echoes like `…R` without a Condition field, and the
   * item-creation feed rejects those numbers). `matches[0]` is the listing-safe pick. */
  matches: CatalogMatch[];
}

export interface ResolveCatalogOptions {
  correlationId?: string;
  signal?: AbortSignal;
  includeRaw?: boolean;
  /** Overall budget for submit + poll + result, ms. Default 120_000. */
  timeoutMs?: number;
  /** First poll delay, ms. Default 2_000. Grows 1.5x per poll up to `maxPollIntervalMs`. */
  pollIntervalMs?: number;
  /** Poll delay ceiling, ms. Default 15_000. */
  maxPollIntervalMs?: number;
}

export interface ResolveCatalogResult {
  marketplace: NeweggMarketplace;
  /** Report request id, when a lookup report was actually submitted (absent when every input
   * was a `neweggItemNumber` passthrough). */
  requestId?: string;
  resolutions: CatalogResolution[];
  correlationId: string;
  raw?: unknown;
}

export interface CatalogLookupSubmission {
  marketplace: NeweggMarketplace;
  requestId: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Processing state of any reportmgmt report (the status endpoint is report-type independent). */
export type ReportState = "submitted" | "inProgress" | "finished" | "cancelled" | "unknown";

export type CatalogLookupState = ReportState;

export interface CatalogLookupStatus {
  marketplace: NeweggMarketplace;
  requestId: string;
  status: CatalogLookupState;
  /** Newegg's literal status string, for diagnostics when `status` is `"unknown"`. */
  statusRaw?: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface CatalogLookupResultPage {
  marketplace: NeweggMarketplace;
  requestId: string;
  matches: CatalogMatch[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/**
 * Catalog resolution over the async Item Lookup Report (`reportmgmt`, contracts §12).
 * Read-only: report submission creates a report job and mutates nothing on the account.
 */
export interface CatalogApi {
  /**
   * One-call facade: submit → poll → fetch every result page → per-input resolutions.
   * Throws {@link CatalogLookupTimeoutError} (carrying the `requestId`) when the report is
   * not finished within `timeoutMs` — continue with {@link CatalogApi.lookupStatus} /
   * {@link CatalogApi.lookupResult} instead of resubmitting.
   */
  resolve(
    input: CatalogLookupInput | CatalogLookupInput[],
    options?: ResolveCatalogOptions,
  ): Promise<ResolveCatalogResult>;
  /**
   * Submit an Item Lookup Report (max 1000 items). Rejects `neweggItemNumber` inputs
   * (nothing to look up) with {@link NeweggValidationError}.
   */
  submitLookup(
    inputs: CatalogLookupInput[],
    options?: RequestOptions,
  ): Promise<CatalogLookupSubmission>;
  /** Check a submitted lookup's processing state. */
  lookupStatus(requestId: string, options?: RequestOptions): Promise<CatalogLookupStatus>;
  /** Fetch one page (1-based, 100 rows) of a FINISHED lookup's results. */
  lookupResult(
    requestId: string,
    page?: number,
    options?: RequestOptions,
  ): Promise<CatalogLookupResultPage>;
}

// ----------------------------------------------------------------------------
// listings (existing item creation; contracts §13) — WRITE surface
// ----------------------------------------------------------------------------
export type ListingCondition = "New" | "Refurbished";
export type ListingShipping = "Default" | "Free";

/** One seller offer to create on an item already in Newegg's catalog (contracts §13).
 * At least one identifier (neweggItemNumber / upc / manufacturerPartNumber) is required;
 * `manufacturer` is ALWAYS required and must match Newegg's predefined manufacturer name
 * (carry it from `catalog.resolve()` matches). */
export interface CreateListingInput {
  /** Seller SKU, <=40 chars, immutable once created. */
  sellerPartNumber: string;
  manufacturer: string;
  neweggItemNumber?: string;
  upc?: string;
  /** Maps to the wire field `ManufacturerPartsNumber`. */
  manufacturerPartNumber?: string;
  sellingPrice: number;
  /** Available quantity for the default warehouse. */
  quantity: number;
  /** Default "New". CA supports only New/Refurbished. Immutable once created. */
  condition?: ListingCondition;
  /** Default 1. Immutable once created. */
  packsOrSets?: number;
  /** Default "Default" (seller-portal shipping settings). */
  shipping?: ListingShipping;
  /** Default false: the offer is created DEACTIVATED (hidden, not for sale). */
  activate?: boolean;
  currency?: "USD" | "CAD";
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  /** ISO 3166-1 alpha-3. */
  countryOfOrigin?: string;
  /** Business days, 1-14. Newegg defaults to 2 when omitted. */
  leadTime?: number;
  shippingTemplate?: string;
}

/** A validated input with defaults resolved and its position recorded. */
export interface NormalizedCreateListing extends CreateListingInput {
  inputIndex: number;
  condition: ListingCondition;
  packsOrSets: number;
  shipping: ListingShipping;
  activate: boolean;
}

/** Offline plan for a listing creation — validation + envelopes, zero network. */
export interface ListingCreatePreview {
  marketplace: NeweggMarketplace;
  items: NormalizedCreateListing[];
  itemCount: number;
  chunkCount: number;
  warnings: string[];
  /** One §13.2 envelope per chunk — exactly what `create` would submit. */
  envelopes: unknown[];
}

/** Existing-item listing creation (contracts §13). WRITE: `create` mutates the account. */
/** Accepted by `previewCreate`/`create`: raw inputs OR the normalized output of a prior
 * `previewCreate` (round-trip safe — `inputIndex` is stripped internally). */
export type CreateListingInputOrNormalized = CreateListingInput | NormalizedCreateListing;

export interface ListingsApi {
  /** Validate + normalize + build envelopes without any network access. */
  previewCreate(
    input: CreateListingInputOrNormalized | CreateListingInputOrNormalized[],
  ): ListingCreatePreview;
  /** Submit the Existing Item Creation feed. Poll the returned requestId(s) with
   * `feeds.getStatus` / `feeds.getResult`. */
  create(
    input: CreateListingInputOrNormalized | CreateListingInputOrNormalized[],
    options?: RequestOptions,
  ): Promise<FeedSubmission>;
}

// ----------------------------------------------------------------------------
// storefront (public buy-box / offers; contracts §14) — UNOFFICIAL, read-only
// ----------------------------------------------------------------------------

/** Per-request options for the storefront surface. The storefront is unauthenticated and
 * carries no correlation id or rate-limit headers, so only cancellation and timeout apply. */
export interface StorefrontRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * One seller offer on a public storefront product page.
 *
 * UNOFFICIAL public storefront endpoint — not part of the seller API, no SLA, may change
 * without notice; read-only.
 */
export interface StorefrontOffer {
  /** The offer's item number. Newegg first-party offers echo the PARENT catalog number;
   * marketplace offers carry the seller offer number (`9SI…`). */
  readonly offerItemNumber: string;
  /** Undefined for Newegg first-party offers (the storefront sends `null`). */
  readonly sellerName: string | undefined;
  /** Undefined for Newegg first-party offers (`Seller` is null or its `SellerId` is empty). */
  readonly sellerId: string | undefined;
  /** True when the offer is sold by Newegg itself rather than a marketplace seller. */
  readonly isNewegg: boolean;
  /** `UnitCost` — the offer price in the storefront's currency (CAD on newegg.ca). */
  readonly price: number;
  /** Raw `ShippingCharge`. CAUTION: `0.01` is observed even on offers the site labels
   * "Free Shipping", so a non-zero value does NOT reliably mean paid shipping. */
  readonly shippingCharge: number;
  readonly inStock: boolean;
  readonly active: boolean;
}

/**
 * All seller offers listed for one parent product on the public storefront.
 *
 * UNOFFICIAL public storefront endpoint — not part of the seller API, no SLA, may change
 * without notice; read-only.
 */
export interface StorefrontOffersResult {
  /** The parent catalog identifier actually queried (post-normalization). */
  readonly parentItemNumber: string;
  /** Offers in the storefront's own order. */
  readonly offers: readonly StorefrontOffer[];
  /** **ASSUMPTION**: the first offer is the buy-box winner — the storefront's ordering looks
   * like its featured ranking and matched the page's buy box in every observation, but this
   * is not documented anywhere. `undefined` when there are no offers. */
  readonly buyBox: StorefrontOffer | undefined;
  /** The envelope's `Total` (offer count across all pages), falling back to `offers.length`. */
  readonly total: number;
}

/**
 * Either a parent catalog identifier or a seller offer number.
 *
 * `itemNumber` accepts the dashed catalog form (`20-156-294`), the product-page form
 * (`N82E16820156294`, normalized to dashed), or a marketplace-style parent CODE
 * (`3C6-00T1-002H0`). `offerNumber` is a `9SI…` seller offer number, which costs one extra
 * request: the SDK resolves it to its parent via the product page's 301 redirect first.
 */
export type GetOffersArgs = { itemNumber: string } | { offerNumber: string };

/**
 * Read the public storefront's buy box and competing seller offers for a product.
 *
 * UNOFFICIAL public storefront endpoint — not part of the seller API, no SLA, may change
 * without notice; read-only. It sends no credentials and touches nothing on the seller
 * account. Only the `us` and `ca` marketplaces have a public storefront: on `b2b` every call
 * throws {@link UnsupportedMarketplaceOperationError}.
 */
export interface StorefrontApi {
  /**
   * Fetch every seller offer for a product (contracts §14.1). Throws
   * {@link NeweggApiError} on a non-2xx response, an unparsable body, or an offer number
   * whose product page does not redirect to a resolvable parent.
   */
  getOffers(
    args: GetOffersArgs,
    options?: StorefrontRequestOptions,
  ): Promise<StorefrontOffersResult>;
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
// pricing reads (Get Item Price; contracts §15) — READ-only
// ----------------------------------------------------------------------------
/** Active promotion lock/type reported by `OnPromotion` (wire codes 1–5). */
export type PricePromotion =
  "priceLock" | "promotionCode" | "autoAddToCart" | "combo" | "volumeDiscount";

export interface GetPriceInput {
  identifier: ItemIdentifier;
  /**
   * US only: ISO 3166-1 alpha-3 destination countries to return prices for (e.g. `["USA"]`).
   * Omit for every country the item sells to. Ignored on B2B/CAN (single-market).
   */
  countries?: string[];
}

export interface GetPriceManyInput {
  /** 1–100 distinct identifiers are priced with one read request each (no wire batch; §15.3). */
  identifiers: ItemIdentifier[];
  /** US only; see {@link GetPriceInput.countries}. */
  countries?: string[];
}

export interface GetPriceManyOptions extends RequestOptions {
  /** Bounded parallelism of the per-item reads. Default 4. */
  concurrency?: number;
}

/** One price record: a US destination country, or the single B2B/CAN market. */
export interface PriceEntry {
  /** US only (ISO alpha-3). Absent on B2B/CAN. */
  countryCode?: string;
  /**
   * ISO 4217 code. US: as reported by Newegg per country. B2B/CAN responses carry no
   * currency, so it is inferred from the marketplace (USD for `b2b`, CAD for `ca`; the
   * documented default of the inventory-and-price feed) and `currencyInferred` is true.
   */
  currency?: string;
  currencyInferred: boolean;
  /** Whether the item is active (listed) in this country/market. */
  active?: boolean;
  /** Manufacturer's suggested retail price; documented but absent from the sample payloads. */
  msrp?: number;
  /** Minimum advertised price; 0 / absent means none. Ignored when `checkoutMap` is true. */
  map?: number;
  /** True: the price is shown only at checkout and `map` is ignored. */
  checkoutMap?: boolean;
  sellingPrice?: number;
  /** `EnableFreeShipping`: true = free shipping, false = the default shipping rule. */
  freeShipping?: boolean;
  promotions: PricePromotion[];
  /** Max units per customer per 48 hours (max 500). */
  limitQuantity?: number;
}

export interface ItemPriceSnapshot {
  marketplace: NeweggMarketplace;
  itemNumber?: string;
  sellerPartNumber?: string;
  /** B2B/CAN only (`ShipByNewegg`). */
  shippedByNewegg?: boolean;
  /** US: one per destination country. B2B/CAN: exactly one, without `countryCode`. */
  prices: PriceEntry[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  /** Only when `includeRaw`. */
  raw?: unknown;
}

/** A per-identifier read failure inside a {@link PriceBatchSnapshot} (never secret-bearing). */
export interface PriceReadFailure {
  identifier: ItemIdentifier;
  errorCode?: string;
  httpStatus?: number;
  message: string;
}

export interface PriceBatchSnapshot {
  marketplace: NeweggMarketplace;
  /** Successful reads, in the order the (de-duplicated) identifiers were requested. */
  items: ItemPriceSnapshot[];
  bySellerPartNumber: ReadonlyMap<string, ItemPriceSnapshot>;
  byItemNumber: ReadonlyMap<string, ItemPriceSnapshot>;
  /** Identifiers Newegg reported as unknown to this seller (CT026 / CT010). */
  missingIdentifiers: ItemIdentifier[];
  /** Identifiers whose read failed for any other reason; the rest of the batch still returns. */
  failures: PriceReadFailure[];
  totalCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

// ----------------------------------------------------------------------------
// pricing writes (contracts §16) — WRITE surface
// ----------------------------------------------------------------------------
/** One selling-price assignment. Only `SellingPrice` is ever sent — never MAP/MSRP/shipping/Active. */
export interface PriceUpdate {
  identifier: ItemIdentifier;
  /** New selling price: > 0, <= 99999.99, at most 2 decimal places. Absolute, not a delta. */
  sellingPrice: number;
  /** US only (required there): uppercase ISO 3166-1 alpha-3 destination country. Rejected on B2B/CA. */
  countryCode?: string;
  /** US only (required there): ISO 4217 code that must match the country (CT075 otherwise). Rejected on B2B/CA. */
  currency?: string;
  /** Caller bookkeeping, never sent to Newegg. */
  metadata?: Record<string, string>;
}

export interface NormalizedPriceUpdate extends PriceUpdate {
  /** Index in the caller's original array. */
  inputIndex: number;
}

export interface PreviewPriceOptions extends RequestOptions {
  /** Read each item's current price to compute the change and flag risks (reads only). Default true. */
  includeCurrentPrice?: boolean;
}

/** `blocked`: do not apply (see `blockers`). `warning`: applies, but read `warnings`. */
export type PriceChangeStatus = "ok" | "warning" | "blocked" | "unchecked";

export interface PriceChange {
  inputIndex: number;
  identifier: ItemIdentifier;
  countryCode?: string;
  newSellingPrice: number;
  /** Currency the new price is read as: the update's (US) or the current one's / inferred one's. */
  currency?: string;
  currentSellingPrice?: number;
  /** Signed percent change vs the current price; undefined when the current price is 0/unknown. */
  changePercent?: number;
  active?: boolean;
  map?: number;
  msrp?: number;
  checkoutMap?: boolean;
  promotions: PricePromotion[];
  status: PriceChangeStatus;
  blockers: string[];
  warnings: string[];
}

export interface PriceUpdatePreview {
  marketplace: NeweggMarketplace;
  /** Post-validation, post-dedup (last-write-wins). Blocked items are still listed here. */
  normalizedUpdates: NormalizedPriceUpdate[];
  deduplicated: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }>;
  /** One per normalized update, in the same order. */
  changes: PriceChange[];
  warnings: string[];
  correlationId: string;
}

export interface UpdatePricesOptions extends RequestOptions {
  /** Read each price back after the write and compare. Default true. */
  verify?: boolean;
  /** Bounded parallelism of the per-item writes. Default 2. */
  concurrency?: number;
}

/**
 * `verified`: Newegg accepted the write AND a read-back shows the new price.
 * `accepted`: Newegg accepted it; read-back skipped (`verify: false`).
 * `unverified`: Newegg accepted it but the read-back differs or failed (deactivated items are
 *   silently ignored while reported as success, contracts §6.2; reads can also lag).
 * `unknown`: the request may or may not have reached Newegg (timeout / 5xx after retries).
 * `failed`: Newegg rejected it, or it provably never left.
 */
export type PriceOutcomeStatus = "verified" | "accepted" | "unverified" | "unknown" | "failed";

export interface PriceUpdateOutcome {
  inputIndex: number;
  identifier: ItemIdentifier;
  countryCode?: string;
  requestedSellingPrice: number;
  status: PriceOutcomeStatus;
  /** The price the read-back (or, failing that, the write response) reported. */
  observedSellingPrice?: number;
  errorCode?: string;
  message?: string;
}

export interface PriceUpdateResult {
  operationId: string;
  correlationId: string;
  marketplace: NeweggMarketplace;
  submittedItemCount: number;
  /** `verified` + `accepted`. */
  appliedItemCount: number;
  failedItemCount: number;
  /** `unverified` + `unknown`: re-read the price before trusting or retrying. */
  unresolvedItemCount: number;
  deduplicatedItemCount: number;
  items: PriceUpdateOutcome[];
  warnings: string[];
  rateLimit?: RateLimitInfo;
}

/** Pricing: Get Item Price reads (contracts §15) plus gated selling-price writes (§16). */
export interface PricingApi {
  /** One Get Item Price read. Throws {@link NeweggApiError} (e.g. CT026) for unknown items. */
  get(input: GetPriceInput, options?: RequestOptions): Promise<ItemPriceSnapshot>;
  /** Like {@link PricingApi.get} but returns `undefined` for an unknown item (CT026 / CT010). */
  tryGet(input: GetPriceInput, options?: RequestOptions): Promise<ItemPriceSnapshot | undefined>;
  /**
   * Prices many identifiers. Newegg documents batch-price endpoints but their wire shape is
   * unverified (contracts §15.3), so this fans out single reads with bounded concurrency.
   * Unknown items land in `missingIdentifiers`, other per-item failures in `failures`;
   * credential errors, rate-limit exhaustion and aborts still throw.
   */
  getMany(input: GetPriceManyInput, options?: GetPriceManyOptions): Promise<PriceBatchSnapshot>;
  /**
   * Validates, de-duplicates (last-write-wins) and risk-checks selling-price updates WITHOUT
   * writing. Reads each current price (unless `includeCurrentPrice: false`) to compute the
   * change and flag blockers (unknown item, currency mismatch, price above MSRP) and warnings
   * (inactive item, promotion lock, below MAP, no-op).
   */
  previewUpdate(
    updates: PriceUpdate | PriceUpdate[],
    options?: PreviewPriceOptions,
  ): Promise<PriceUpdatePreview>;
  /**
   * WRITE. Assigns absolute selling prices, one request per item (1-100 per call). Price
   * assignments are idempotent, so the direct-operation retry policy applies (ADR 0004); an
   * ambiguous failure that survives the retries is reported per item as `unknown` (after a
   * read-back attempt), never thrown; Newegg rejections (including credential errors) are
   * reported per item as `failed`. Only validation errors and caller aborts throw. Does NOT
   * apply preview blockers - callers (the MCP tools) enforce those.
   */
  update(
    updates: PriceUpdate | PriceUpdate[],
    options?: UpdatePricesOptions,
  ): Promise<PriceUpdateResult>;
}

// ----------------------------------------------------------------------------
// reports (Reports Management reads; contracts §17) — READ-only
// ----------------------------------------------------------------------------
/**
 * A date criterion for a report. Strings are sent as given and must be a calendar date
 * (`YYYY-MM-DD`, the form in Newegg's samples) or a Pacific date-time (`M/D/YYYY H:mm[:ss]`,
 * `YYYY-MM-DD HH:mm[:ss]`). A `Date` is rendered as its **Pacific** calendar date
 * (`YYYY-MM-DD`) - Newegg interprets every report date as Pacific Time.
 */
export type ReportDateInput = string | Date;

/** Download hook for file-style reports; receives the credential-bearing report file URL. */
export type ReportFileDownloader = (
  url: string,
  options: { signal?: AbortSignal; maxBytes: number; timeoutMs: number },
) => Promise<Uint8Array>;

export interface ReportSubmission {
  marketplace: NeweggMarketplace;
  /** Poll with `status(requestId)` / continue with `result` or `waitForRequest` - do NOT resubmit. */
  requestId: string;
  /** Newegg's `RequestType` echo, e.g. `SETTLEMENT_SUMMARY_REPORT`. */
  requestType?: string;
  /** Pacific `RequestDate`. */
  requestDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  /** Sanitized raw payload (any credential-bearing URL is redacted). */
  raw?: unknown;
}

export interface ReportStatus {
  marketplace: NeweggMarketplace;
  requestId: string;
  status: ReportState;
  /** Newegg's literal status string, for diagnostics when `status` is `"unknown"`. */
  statusRaw?: string;
  requestType?: string;
  totalCount?: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Options for the `waitFor*` helpers. */
export interface ReportWaitOptions {
  correlationId?: string;
  signal?: AbortSignal;
  includeRaw?: boolean;
  /**
   * Overall budget for submit + poll + fetch, ms. Default 120_000 for the file reports (daily
   * inventory / price); 300_000 for the settlement reports, which can take ~170 s to generate.
   */
  timeoutMs?: number;
  /** First poll delay, ms. Default 2_000. Grows 1.5x per poll up to `maxPollIntervalMs`. */
  pollIntervalMs?: number;
  /** Poll delay ceiling, ms. Default 15_000. */
  maxPollIntervalMs?: number;
  /** Paged reports: stop after this many result pages (100 rows each). Default 50. */
  maxPages?: number;
  /** File reports: keep at most this many parsed rows (the rest are counted, not kept). Default 50_000. */
  maxRows?: number;
}

/** One result page of a paged (inline) report. */
export interface ReportResultPage<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  rows: Row[];
  /** 1-based page index. */
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  requestDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Every page of a paged report, gathered by `waitForRequest` / `waitForResult`. */
export interface CollectedReport<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  rows: Row[];
  /** Total rows Newegg reports for the whole report. */
  totalCount: number;
  pagesFetched: number;
  /** True when `maxPages` stopped the fetch before the last page (`rows.length < totalCount`). */
  truncated: boolean;
  correlationId: string;
}

/** Result-page options (the optional `version` query selects the response field set). */
export interface ReportResultOptions extends RequestOptions {
  /**
   * Response `version` query parameter (settlement summary: 306-313; each adds fields, §17.2).
   * Default `"313"`, the newest documented set. ASSUMPTION: accepted on every platform.
   */
  version?: string;
}

// -- settlement summary -------------------------------------------------------
export interface SettlementSummaryInput {
  /** Start of the settlement range (Pacific). */
  dateFrom: ReportDateInput;
  /** End of the settlement range (Pacific). */
  dateTo: ReportDateInput;
}

/** Money fields of a settlement-summary row (strings on the wire; parsed to numbers). */
export type SettlementSummaryAmountField =
  | "itemPrice"
  | "shipping"
  | "taxDuty"
  | "gstTotal"
  | "hstTotal"
  | "gstAndHst"
  | "pstTotal"
  | "pstAndQst"
  | "ehfTotal"
  | "other"
  | "recyclingFeeTotal"
  | "totalOrderAmount"
  | "refunds"
  | "chargeBack"
  | "miscellaneousAdjustment"
  | "courtesyRefund"
  | "totalRefunds"
  | "neweggCommissionFee"
  | "neweggTransactionFee"
  | "neweggRefundCommissionFee"
  | "neweggMonthlyFee"
  | "neweggStorageFee"
  | "neweggRmaBuyoutFee"
  | "neweggServiceFeeTax"
  | "neweggPremierFee"
  | "neweggShippingLabelFee"
  | "creditCardPayment"
  | "fulfillmentByNeweggFee"
  | "multiChannelFee"
  | "adjustmentFee"
  | "merchandisingFee"
  | "totalNeweggFee"
  | "totalSettlement"
  | "salesTaxFeeCollectedFromCustomer"
  | "salesTaxFeesLiabilityShiftToNewegg"
  | "reservedBalance"
  | "previousReservedBalance";

/**
 * One settlement. Which amount fields are present depends on platform and response version
 * (§17.2): absent means "not reported", never zero. Amounts are USD on Newegg.com and
 * Neweggbusiness.com and CAD on Newegg.ca.
 */
export type SettlementSummaryRow = {
  settlementDate?: { raw: string; iso?: string };
  settlementDateFrom?: { raw: string; iso?: string };
  settlementDateTo?: { raw: string; iso?: string };
  settlementId?: string;
  checkNumber?: string;
  memo?: string;
  /** Wire fields this SDK version does not map (scalar values only) - forward compatibility. */
  unmapped?: Record<string, string>;
} & { [K in SettlementSummaryAmountField]?: number };

export interface SettlementSummaryReportApi {
  /** Submit a Settlement Summary report for a settlement-date range (100 submissions/hour). */
  submit(input: SettlementSummaryInput, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  /** One result page (1-based, 100 rows) of a FINISHED report. */
  result(
    requestId: string,
    page?: number,
    options?: ReportResultOptions,
  ): Promise<ReportResultPage<SettlementSummaryRow>>;
  /** Poll an already-submitted report to FINISHED, then fetch every page. */
  waitForRequest(
    requestId: string,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<SettlementSummaryRow>>;
  /** submit + waitForRequest. Throws {@link ReportTimeoutError} (with the requestId) on timeout. */
  waitForResult(
    input: SettlementSummaryInput,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<SettlementSummaryRow>>;
}

// -- settlement transactions --------------------------------------------------
/** Settlement `TransactionType` filter (wire integer 0-32; §17.3). */
export type SettlementTransactionType =
  | "all"
  | "order"
  | "refund"
  | "creditRequest"
  | "chargeback"
  | "monthlyFee"
  | "fulfillByNeweggFee"
  | "multiChannelFee"
  | "rmaProcessingFee"
  | "taxAndDuty"
  | "storageFee"
  | "rmaBuyoutFee"
  | "adjustmentFee"
  | "monthlyFeeByCreditCard"
  | "sbnInboundFee"
  | "merchandisingFee"
  | "premierFee"
  | "shippingLabelFee"
  | "returnAndDisposalFee"
  | "relabelingFee"
  | "recyclingFeeOrEhf"
  | "returnShippingLabelFee"
  | "serviceFeeTax"
  | "printShippingLabelService"
  | "reservedBalance"
  | "previousReservedBalance"
  | "commissionIncentiveRefund"
  | "unsoldListingFee"
  | "orderProcessingFee"
  | "salesTaxAndFees"
  | "sbnInboundIncomplianceCharges"
  | "sponsoredAds"
  | "itemOverageFee";

/**
 * Criteria for a Settlement Transaction report. Newegg requires `settlementId`, `settlementDate`,
 * or both `settlementDateFrom` and `settlementDateTo` (error RP020); the SDK enforces this
 * before sending.
 */
export interface SettlementTransactionsInput {
  settlementDateFrom?: ReportDateInput;
  settlementDateTo?: ReportDateInput;
  settlementDate?: ReportDateInput;
  settlementId?: string | number;
  orderNumber?: string | number;
  /** Default `"all"`. */
  transactionType?: SettlementTransactionType;
}

export interface SettlementTransactionRow {
  transactionDate?: { raw: string; iso?: string };
  /** Newegg's transaction label, e.g. `Order`. */
  transactionType?: string;
  orderNumber?: string;
  invoiceNumber?: string;
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  itemDescription?: string;
  /** Newegg's condition label, e.g. `New`, `Used - Like New`. */
  itemCondition?: string;
  /** USD (Newegg.com / Neweggbusiness.com) or CAD (Newegg.ca). */
  amount?: number;
  shipping?: number;
  commissionFee?: number;
  settlementId?: string;
  memo?: string;
}

export interface SettlementTransactionReportApi {
  submit(input: SettlementTransactionsInput, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  result(
    requestId: string,
    page?: number,
    options?: RequestOptions,
  ): Promise<ReportResultPage<SettlementTransactionRow>>;
  waitForRequest(
    requestId: string,
    options?: ReportWaitOptions,
  ): Promise<CollectedReport<SettlementTransactionRow>>;
  waitForResult(
    input: SettlementTransactionsInput,
    options?: ReportWaitOptions,
  ): Promise<CollectedReport<SettlementTransactionRow>>;
}

// -- file-style reports (daily inventory / daily price) -------------------------
/** Output formats the SDK can parse. (Newegg also offers XLS; it is not parsed here.) */
export type ReportTextFileType = "csv" | "txt";

/**
 * Descriptor of a finished file report. The file's FTP URL embeds credentials, so it is NEVER
 * exposed: only the host and file name are. Use `download` / `waitFor*` to read the rows.
 */
export interface ReportFileInfo {
  marketplace: NeweggMarketplace;
  requestId: string;
  /** False when the result carried no `ReportFileURL` yet. */
  available: boolean;
  fileName?: string;
  host?: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface DownloadedReport<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  fileName?: string;
  /** Parsed rows, capped at `maxRows`. */
  rows: Row[];
  /** Every data row in the file (>= `rows.length`). */
  totalRows: number;
  truncated: boolean;
  /** Source files read (a zip package holds several when the account has > 40,000 items). */
  fileCount: number;
  correlationId: string;
}

export interface DailyInventoryInput {
  /** `"all"` (default), `"seller"` (Fulfill by Seller) or `"newegg"` (Fulfill by Newegg). */
  fulfillType?: "all" | "seller" | "newegg";
  /** US only: 3-letter ISO warehouse codes to include (omit for all). Rejected on B2B/CA. */
  warehouses?: string[];
  /** Default `"csv"`. */
  fileType?: ReportTextFileType;
}

/**
 * One inventory line. US reports carry `warehouseLocation`; B2B/CA reports carry the price and
 * activation columns of the default warehouse (§17.4). Unmapped columns land in `extra`.
 */
export interface DailyInventoryRow {
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  /** US only (3-letter ISO). */
  warehouseLocation?: string;
  /** e.g. `Seller`, `Newegg`. */
  fulfillmentOption?: string;
  inventory?: number;
  /** B2B/CA only from here down. */
  currency?: string;
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  sellingPrice?: number;
  /** `default` or `free`. */
  shipping?: string;
  activationMark?: boolean;
  memo?: string;
  extra?: Record<string, string>;
}

export interface DailyPriceInput {
  /** 3-letter ISO destination countries (default: all). */
  countries?: string[];
  /** Default `"csv"`. */
  fileType?: ReportTextFileType;
}

export interface DailyPriceRow {
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  countryCode?: string;
  currency?: string;
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  sellingPrice?: number;
  /** `default` or `free`. */
  shipping?: string;
  activationMark?: boolean;
  memo?: string;
  extra?: Record<string, string>;
}

export interface FileReportApi<Input, Row> {
  submit(input: Input, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  /** The finished report's file descriptor (host + file name; the credential URL is withheld). */
  result(requestId: string, options?: RequestOptions): Promise<ReportFileInfo>;
  /** Fetch the finished report's file over FTP and parse it. */
  download(requestId: string, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
  /** Poll an already-submitted report to FINISHED, then download + parse. */
  waitForRequest(requestId: string, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
  /** submit + waitForRequest. Throws {@link ReportTimeoutError} (with the requestId) on timeout. */
  waitForResult(input: Input, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
}

// -- item basic information (file; the only way to enumerate every listing) ---------
/** Item Basic Information `Status` filter: 0 all (default) / 1 active only / 2 inactive only. */
export type ItemBasicInfoStatus = "all" | "active" | "inactive";

export interface ItemBasicInfoInput {
  /** Which listings to include (default `"all"`). */
  status?: ItemBasicInfoStatus;
  /** Default `"csv"`. */
  fileType?: ReportTextFileType;
}

/** A custom-variety option of a listing (`Custom Variety N Name` / `Value`). */
export interface ItemVarietyOption {
  name: string;
  value: string;
}

/**
 * One listing from the Item Basic Information report (contracts §17.8, live-verified on CAN
 * 2026-10-10). The report carries NO price or inventory - join the Daily Inventory report
 * (`reports.dailyInventory`) on `sellerPartNumber` for those. Columns the SDK does not map land
 * in `extra` (keyed by the lower-cased, punctuation-free header).
 */
export interface ItemBasicInfoRow {
  /** `Seller Part #` - the SKU. */
  sellerPartNumber?: string;
  /** `NE Item #` - the Newegg item number. */
  neweggItemNumber?: string;
  /** `Manufacturer Part #`. */
  manufacturerPartNumber?: string;
  /** Absent for listings without a UPC. */
  upc?: string;
  /** The listing's `Status` column, verbatim (`Active` / `Inactive`). */
  status?: string;
  /** `true` when `status` is Active, `false` when Inactive; absent when the column is missing/unknown. */
  active?: boolean;
  /** Catalog title (the column header is misspelled `Wesite Short Title` by Newegg). */
  title?: string;
  industry?: string;
  subcategory?: string;
  /** Bullet-point description; may contain newlines. */
  bulletDescription?: string;
  /** Item dimensions / weight as reported (units are not documented). */
  itemLength?: number;
  itemWidth?: number;
  itemHeight?: number;
  itemWeight?: number;
  /** `Item Image`: the comma-separated image URL list, split. */
  imageUrls?: string[];
  /** `Date Created` as a calendar date `YYYY-MM-DD` (the file gives `MM/DD/YYYY`; month-first assumed). */
  dateCreated?: string;
  /** Marketplace platform code, e.g. `CAN`. */
  platform?: string;
  /** Variant group id, shared by every option of a variation family. */
  itemGroupId?: string;
  /** Up to three custom variety options. */
  varieties?: ItemVarietyOption[];
  extra?: Record<string, string>;
}

// -- order list / RMA list (paged inline) --------------------------------------
/** A paged (inline JSON) report: submit, status, page-by-page result and the wait helpers. */
export interface PagedReportApi<Input, Row> {
  submit(input: Input, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  /** One result page (1-based, 100 rows) of a FINISHED report. */
  result(
    requestId: string,
    page?: number,
    options?: ReportResultOptions,
  ): Promise<ReportResultPage<Row>>;
  /** Poll an already-submitted report to FINISHED, then fetch every page (up to `maxPages`). */
  waitForRequest(
    requestId: string,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<Row>>;
  /** submit + waitForRequest. Throws {@link ReportTimeoutError} (with the requestId) on timeout. */
  waitForResult(
    input: Input,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<Row>>;
}

/** What the Order List report's `KeywordsValue` is matched against (`KeywordsType` 1-9). */
export type OrderListKeywordType =
  | "orderNumber"
  | "invoiceNumber"
  | "customerName"
  | "sellerPartNumber"
  | "neweggItemNumber"
  | "customerPhoneNumber"
  | "titleDescription"
  | "manufacturer"
  | "sellerOrderNumber";

/** Criteria for the Order List report. `status` is required by Newegg. */
export interface OrderListInput {
  /** Order status to list (`Status` 0-5; required). `"unknown"` is not a valid criterion. */
  status: Exclude<OrderStatus, "unknown">;
  /** Keyword search (`KeywordsType` + `KeywordsValue`). Omit for all. */
  keyword?: { type: OrderListKeywordType; value: string };
  /** Fulfillment/channel filter (`Type`: all / sbn / sbs / multiChannel). `"nws"` is not offered. */
  type?: Exclude<OrderTypeFilter, "nws">;
  /** Order-date range start (Pacific). `Date` is rendered as its Pacific wall clock. */
  dateFrom?: Date | string;
  /** Order-date range end (Pacific). */
  dateTo?: Date | string;
  /** Only orders that auto-void within this many hours (`VoidSoon`). */
  voidSoon?: 24 | 48;
  /** `false` excludes already-downloaded orders. Default includes all. */
  includeDownloaded?: boolean;
  /** Newegg.com only: ISO 3-letter ship-to country. Rejected on B2B/CA. */
  countryCode?: string;
  /** Newegg.com only (`PremierOrder`). Rejected on B2B/CA. */
  premierOrder?: PremierOrderFilter;
}

/** Criteria for the RMA List report. Every field is optional. */
export interface RmaListInput {
  keyword?: { type: RmaKeywordType; value: string };
  status?: Exclude<RmaStatus, "unknown">;
  type?: Exclude<RmaType, "unknown">;
  processedBy?: RmaProcessedBy;
  /** RMA-date range start (Pacific). */
  dateFrom?: Date | string;
  /** RMA-date range end (Pacific). */
  dateTo?: Date | string;
}

/**
 * Read-only Reports Management reports. Report submission is a POST that creates a report job
 * only - it mutates nothing on the seller account (contracts §12 / §17 classification).
 */
export interface ReportsApi {
  /**
   * Item Basic Information report (file via FTP): every listing of the seller (SKU, Newegg item
   * number, manufacturer part number, UPC, status). The only way to enumerate "all my listings".
   */
  readonly itemBasicInfo: FileReportApi<ItemBasicInfoInput, ItemBasicInfoRow>;
  /**
   * Order List report (paged inline): orders in the same shape as {@link OrdersApi.list}. Rows
   * carry the customer block (PII) exactly as `orders.list` does.
   */
  readonly orderList: PagedReportApi<OrderListInput, Order>;
  /** RMA List report (paged inline): RMAs in the same shape as {@link RmaApi.list} (customer block is PII). */
  readonly rmaList: PagedReportApi<RmaListInput, Rma>;
  /** Settlement Summary report: per-settlement payments, refunds and fees (all platforms). */
  readonly settlementSummary: SettlementSummaryReportApi;
  /** Settlement Transaction report: line-level transactions inside settlements (all platforms). */
  readonly settlementTransactions: SettlementTransactionReportApi;
  /**
   * Daily Inventory report (file via FTP): US per-warehouse quantities; B2B/CA the default
   * warehouse with price and activation status.
   */
  readonly dailyInventory: FileReportApi<DailyInventoryInput, DailyInventoryRow>;
  /** Daily Price report (file via FTP). Newegg.com only; B2B/CA throw {@link UnsupportedMarketplaceOperationError}. */
  readonly dailyPrice: FileReportApi<DailyPriceInput, DailyPriceRow>;
  /** Status of any submitted report by request id (the status endpoint is report-type independent). */
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
}

// ----------------------------------------------------------------------------
// RMA and courtesy refunds - READS only (contracts §18)
// ----------------------------------------------------------------------------
/** Currency of every RMA / refund amount: USD on Newegg.com and Neweggbusiness.com, CAD on Newegg.ca. */
export type RmaCurrency = "USD" | "CAD";

/** RMA lifecycle status (`RMAStatus` 1-6); unrecognized codes map to `"unknown"`. */
export type RmaStatus =
  "open" | "received" | "rejected" | "voided" | "closed" | "processing" | "unknown";

/** RMA kind (`RMAType` 1 replacement / 2 refund). */
export type RmaType = "replacement" | "refund" | "unknown";

/** Who handled the RMA (`RMAProcessedBy` / the `ProcessedBy` filter). */
export type RmaProcessedBy = "seller" | "newegg";

/** Per-item RMA reason (`RMAReason` 1-9). */
export type RmaReason =
  | "itemDamaged"
  | "defective"
  | "incompatible"
  | "noLongerNeeded"
  | "notAsDescribed"
  | "orderedWrongItem"
  | "sentWrongItem"
  | "unsatisfied"
  | "other"
  | "unknown";

/** What {@link ListRmasInput.keyword} searches (`KeywordsType` 1-4). */
export type RmaKeywordType = "rmaNumber" | "orderNumber" | "customerName" | "sellerRmaNumber";

/** Criteria for {@link RmaApi.list}. Every field is optional; omit all to match all RMAs. */
export interface ListRmasInput {
  /** Keyword search (`KeywordsType` + `KeywordsValue`). */
  keyword?: { type: RmaKeywordType; value: string };
  /** Filter by RMA status (`Status`). Note: `"received"` RMAs are not visible in Seller Portal. */
  status?: Exclude<RmaStatus, "unknown">;
  /** Filter by RMA kind (`RMAType`). */
  type?: Exclude<RmaType, "unknown">;
  /** Filter by who processed the RMA (`ProcessedBy`). */
  processedBy?: RmaProcessedBy;
  /** Lower bound on RMA date. `Date` is rendered as Pacific Time; a string is sent verbatim. */
  dateFrom?: Date | string;
  /** Upper bound on RMA date (see {@link ListRmasInput.dateFrom}). */
  dateTo?: Date | string;
  /** 1-based page (default 1). */
  page?: number;
  /** Page size (max 100, default 100). */
  pageSize?: number;
  /**
   * Response field-set `version`. Documented: 307 / 309 / 320 on Newegg.com, 305 / 309 / 320 on
   * Neweggbusiness.com and Newegg.ca. Default `"320"` (adds seller RMA number, replacement order
   * number and the return-shipping label); an unsupported value throws a validation error.
   */
  version?: string;
}

/** One line of an RMA (`RMATransaction`). */
export interface RmaItem {
  sellerPartNumber?: string;
  mfrPartNumber?: string;
  neweggItemNumber?: string;
  description?: string;
  unitPrice?: number;
  returnQuantity?: number;
  /** Refund RMAs: the refund per unit. */
  returnUnitPrice?: number;
  /** Refund RMAs: the refunded shipping amount. */
  refundShippingPrice?: number;
  /** Replacement RMAs: who ships the replacement (`ShippedBy` 0 seller / 1 Newegg). */
  shippedBy?: "seller" | "newegg";
  reason: RmaReason;
  reasonCode?: number;
  reasonDescription?: string;
  /**
   * RMA List report only (`RefundInfo.RMATotalRefund`): the refund total Newegg reports on the
   * line. Documented as the RMA total, so it may repeat on every line of a multi-line RMA.
   */
  rmaTotalRefund?: number;
  /** Whether the item was unboxed (`UnOpen`; Newegg.com and Newegg.ca only). */
  unopened?: boolean;
  /** Seller-facing memo (`Memo`; Newegg.com and Newegg.ca only). */
  memo?: string;
}

/** Return-shipping label attached to an RMA (version 320; `ReturnShippingLabel`). */
export interface RmaReturnLabel {
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedCost?: number;
  paidBy?: string;
}

/** Customer contact block of an RMA. PII: the MCP tools never surface it. */
export interface RmaCustomer {
  name?: string;
  phoneNumber?: string;
  /** Newegg's masked relay address. */
  emailAddress?: string;
  shipTo?: ShipToAddress;
}

/** One RMA from Get RMA Information (contracts §18.1). Amounts are in {@link RmasPage.currency}. */
export interface Rma {
  rmaNumber: string;
  type: RmaType;
  typeDescription?: string;
  /** Seller-assigned RMA reference (versions 307 / 309 / 320 on Newegg.com; 305 / 309 / 320 elsewhere). */
  sellerRmaNumber?: string;
  /** Replacement RMAs only (version 309+). */
  replacementOrderNumber?: string;
  issueUser?: string;
  rmaDate?: { raw: string; iso?: string };
  status: RmaStatus;
  statusDescription?: string;
  /** Replacement RMAs: ship method code / label (`RMAShipMethod*`). */
  shipMethod?: number;
  shipMethodDescription?: string;
  orderNumber?: string;
  orderDate?: { raw: string; iso?: string };
  invoiceNumber?: string;
  orderAmount?: number;
  /** Total order amount minus everything refunded, including this RMA. */
  availableRefundAmount?: number;
  priorRefundAmount?: number;
  /** RMA List report, Newegg.ca only: the GST/HST part of the refund. */
  refundGstOrHstAmount?: number;
  /** RMA List report, Newegg.ca only: the PST/QST part of the refund. */
  refundPstOrQstAmount?: number;
  processedBy?: RmaProcessedBy;
  receiveDate?: { raw: string; iso?: string };
  note?: string;
  customer?: RmaCustomer;
  returnLabel?: RmaReturnLabel;
  items: RmaItem[];
}

/** One page of {@link RmaApi.list} results. */
export interface RmasPage {
  marketplace: NeweggMarketplace;
  rmas: Rma[];
  currency: RmaCurrency;
  /** Echoed 1-based `PageIndex`. */
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** RMA reads (Get RMA Information, 1000 req/hr). Never mutates. */
export interface RmaApi {
  /** Search RMAs (single page). Omit `input` to match all RMAs. */
  list(input?: ListRmasInput, options?: RequestOptions): Promise<RmasPage>;
  /** Fetch one RMA by its Newegg RMA number. Throws {@link NeweggApiError} when none matches. */
  get(rmaNumber: string | number, options?: RequestOptions): Promise<Rma>;
  /** Like {@link RmaApi.get} but resolves to `undefined` when no RMA matches. */
  tryGet(rmaNumber: string | number, options?: RequestOptions): Promise<Rma | undefined>;
}

/** Courtesy refund status (`Status`: Open / Close / Void). */
export type CourtesyRefundStatus = "open" | "closed" | "void" | "unknown";

/** Courtesy refund reason (`ReasonCode` 1-6). */
export type CourtesyRefundReason =
  | "negativeCustomerFeedback"
  | "pricingError"
  | "wrongItemInformation"
  | "shippingDelay"
  | "packageNotReceived"
  | "customerCourtesy"
  | "unknown";

/** What {@link ListCourtesyRefundsInput.keyword} searches (`KeywordsType` 1-3). */
export type CourtesyRefundKeywordType = "courtesyRefundId" | "orderNumber" | "customerName";

/** Criteria for {@link RefundsApi.list}. Every field is optional. */
export interface ListCourtesyRefundsInput {
  keyword?: { type: CourtesyRefundKeywordType; value: string };
  status?: Exclude<CourtesyRefundStatus, "unknown">;
  /** Lower bound on the courtesy refund date. `Date` is rendered as Pacific Time. */
  dateFrom?: Date | string;
  dateTo?: Date | string;
  /** 1-based page (default 1). */
  page?: number;
  /** Page size (max 100, default 100). */
  pageSize?: number;
}

/** One courtesy refund (contracts §18.2). Amounts are in the page's {@link RmaCurrency}. */
export interface CourtesyRefund {
  courtesyRefundId: string;
  orderNumber?: string;
  orderAmount?: number;
  invoiceNumber?: string;
  refundAmount?: number;
  reason: CourtesyRefundReason;
  reasonCode?: number;
  reasonDescription?: string;
  noteToCustomer?: string;
  status: CourtesyRefundStatus;
  /** `true` when a Newegg customer-service agent issued the refund. */
  issuedByNewegg?: boolean;
  createdBy?: string;
  createdDate?: { raw: string; iso?: string };
  editedBy?: string;
  editedDate?: { raw: string; iso?: string };
}

/** One page of {@link RefundsApi.list} results. */
export interface CourtesyRefundsPage {
  marketplace: NeweggMarketplace;
  refunds: CourtesyRefund[];
  currency: RmaCurrency;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Processing state of a courtesy refund REQUEST (`RequestStatus`). */
export type CourtesyRefundRequestState =
  "submitted" | "inProgress" | "finished" | "failed" | "cancelled" | "unknown";

/** Status of one courtesy refund request (Get Courtesy Refund Request Status). */
export interface CourtesyRefundRequestStatus {
  requestId: string;
  requestType?: string;
  requestDate?: { raw: string; iso?: string };
  state: CourtesyRefundRequestState;
  /** The wire `RequestStatus` label as sent (e.g. `"IN_PROGRESS"`). */
  stateRaw?: string;
  /** Failure detail when `state` is `"failed"`. */
  processMemo?: string;
  /** The resulting courtesy refund once `state` is `"finished"`. */
  refund?: CourtesyRefund;
}

/** Criteria for {@link RefundsApi.listRequests}. */
export interface ListCourtesyRefundRequestsInput {
  /** Look up specific request ids; when set Newegg ignores every other criterion. */
  requestIds?: string[];
  status?: Exclude<CourtesyRefundRequestState, "unknown">;
  dateFrom?: Date | string;
  dateTo?: Date | string;
  /** Maximum records (Newegg caps it at 100). */
  maxCount?: number;
}

/** Result of {@link RefundsApi.listRequests}. */
export interface CourtesyRefundRequestsResult {
  marketplace: NeweggMarketplace;
  requests: CourtesyRefundRequestStatus[];
  currency: RmaCurrency;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/**
 * Courtesy refund reads (Get Courtesy Refund Information 30 req/min; Get Courtesy Refund Request
 * Status 10,000 req/hr). Issuing a courtesy refund is a WRITE and is deliberately not part of
 * this API.
 */
export interface RefundsApi {
  /** Search courtesy refunds (single page). Omit `input` to match all. */
  list(input?: ListCourtesyRefundsInput, options?: RequestOptions): Promise<CourtesyRefundsPage>;
  /** Fetch one courtesy refund by id. Throws {@link NeweggApiError} when none matches. */
  get(courtesyRefundId: string, options?: RequestOptions): Promise<CourtesyRefund>;
  /** Like {@link RefundsApi.get} but resolves to `undefined` when none matches. */
  tryGet(courtesyRefundId: string, options?: RequestOptions): Promise<CourtesyRefund | undefined>;
  /** Status of submitted courtesy refund requests, filtered by id / status / date. */
  listRequests(
    input?: ListCourtesyRefundRequestsInput,
    options?: RequestOptions,
  ): Promise<CourtesyRefundRequestsResult>;
  /** Status of one courtesy refund request. Throws {@link NeweggApiError} when Newegg returns none. */
  getRequestStatus(
    requestId: string,
    options?: RequestOptions,
  ): Promise<CourtesyRefundRequestStatus>;
}

// ----------------------------------------------------------------------------
// seller / category reference reads (contracts §19)
// ----------------------------------------------------------------------------
/** `Status` of Seller Status Check; anything outside the five documented values is `"unknown"`. */
export type SellerAccountStatus =
  "active" | "suspended" | "inactive" | "terminated" | "closed" | "unknown";

/** `Membership` code of Seller Status Check (0 / 1 / 2); documented for Newegg.com only. */
export type SellerMembership = "nonElite" | "professional" | "enterprise" | "unknown";

/** One fulfillment center of a Newegg.com seller account (`FufillmentCenter`, sic). */
export interface SellerFulfillmentCenter {
  /** ISO 3166-1 alpha-3 country of the warehouse. */
  warehouseLocation?: string;
  /** `WarehouseType` 0 = Ship by Seller, 1 = Ship by Newegg. */
  shippedBy?: "seller" | "newegg";
  /** ISO alpha-3 destination countries this center ships to. */
  shipToCountries: string[];
}

/** Result of {@link ReferenceApi.getSellerStatus}. */
export interface SellerStatus {
  marketplace: NeweggMarketplace;
  sellerName?: string;
  status: SellerAccountStatus;
  /** The `Status` text exactly as Newegg sent it. */
  statusText?: string;
  /** Undefined when the platform sends no membership (documented for Newegg.com only). */
  membership?: SellerMembership;
  /** Newegg.com only; empty on B2B/CAN, whose pages document no fulfillment center list. */
  fulfillmentCenters: SellerFulfillmentCenter[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** One Newegg industry (`IndustryCode` + `IndustryName`). */
export interface Industry {
  code: string;
  name?: string;
}

/** Criteria for {@link ReferenceApi.listIndustries}. */
export interface ListIndustriesInput {
  /** Return only this industry; omit for every industry. An unknown code fails with `DF008`. */
  industryCode?: string;
}

/** Result of {@link ReferenceApi.listIndustries}. */
export interface IndustriesResult {
  marketplace: NeweggMarketplace;
  industries: Industry[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Criteria for {@link ReferenceApi.listSubcategories}. Every field is optional. */
export interface ListSubcategoriesInput {
  /** Restrict to these Newegg subcategory ids. */
  subcategoryIds?: number[];
  /** Restrict to these industry codes (see {@link ReferenceApi.listIndustries}). */
  industryCodes?: string[];
  /** `true` = only enabled subcategories, `false` = only not-enabled; omit for both. */
  enabled?: boolean;
  /**
   * ISO alpha-3 country to check eligibility in (Get Subcategory Status for International
   * Country). Newegg.com only; B2B/CAN throw {@link UnsupportedMarketplaceOperationError}.
   */
  countryCode?: string;
}

/** One subcategory and whether it is enabled for the seller. */
export interface SubcategoryStatus {
  industryCode?: string;
  industryName?: string;
  subcategoryId: number;
  subcategoryName?: string;
  enabled: boolean;
}

/** Result of {@link ReferenceApi.listSubcategories}. */
export interface SubcategoriesResult {
  marketplace: NeweggMarketplace;
  /** Echoed `CountryCode` of the international variant; undefined for the standard call. */
  countryCode?: string;
  subcategories: SubcategoryStatus[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** One property of a subcategory. */
export interface SubcategoryProperty {
  subcategoryId?: number;
  subcategoryName?: string;
  /** The exact name item-creation feeds and {@link ReferenceApi.listPropertyValues} expect. */
  propertyName: string;
  isAdvancedSearch?: boolean;
  isGroupBy?: boolean;
  isRequired?: boolean;
}

/** Result of {@link ReferenceApi.listSubcategoryProperties}. */
export interface SubcategoryPropertiesResult {
  marketplace: NeweggMarketplace;
  subcategoryId: number;
  properties: SubcategoryProperty[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Criteria for {@link ReferenceApi.listPropertyValues}. */
export interface ListPropertyValuesInput {
  /** Property name as returned by {@link ReferenceApi.listSubcategoryProperties}. */
  propertyName: string;
  /** Omit to read the property across every subcategory it applies to. */
  subcategoryId?: number;
}

/** A property with its allowed values (rows Newegg splits one-value-per-row are merged). */
export interface PropertyValues extends SubcategoryProperty {
  values: string[];
}

/** Result of {@link ReferenceApi.listPropertyValues}. */
export interface PropertyValuesResult {
  marketplace: NeweggMarketplace;
  properties: PropertyValues[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/**
 * Seller / category reference reads (contracts §19): account status, industries, subcategory
 * eligibility, and the property metadata item creation needs. All are READS (some via `PUT`);
 * none mutates the seller account.
 */
export interface ReferenceApi {
  /** Seller Status Check: account status, store name, membership and fulfillment centers. */
  getSellerStatus(options?: RequestOptions): Promise<SellerStatus>;
  /** Get Industry List (10,000 req/hr). */
  listIndustries(input?: ListIndustriesInput, options?: RequestOptions): Promise<IndustriesResult>;
  /** Get Subcategory Status (100 req/hr), or its international variant when `countryCode` is set. */
  listSubcategories(
    input?: ListSubcategoriesInput,
    options?: RequestOptions,
  ): Promise<SubcategoriesResult>;
  /** Get Subcategory Properties (100 req/hr). */
  listSubcategoryProperties(
    subcategoryId: number,
    options?: RequestOptions,
  ): Promise<SubcategoryPropertiesResult>;
  /** Get Subcategory Property Values (100 req/hr). */
  listPropertyValues(
    input: ListPropertyValuesInput,
    options?: RequestOptions,
  ): Promise<PropertyValuesResult>;
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
