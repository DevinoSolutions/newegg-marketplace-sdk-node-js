# SDK Public API Contract (binding for implementation)

This file is the binding contract between `@devino/newegg-marketplace-sdk` (implements it
exactly) and `@devino/newegg-marketplace-mcp` (consumes only this surface). Wire shapes
live in `newegg-api-contracts.md`. All declarations below are exported from the SDK root
entry point unless noted.

```ts
// ----------------------------------------------------------------------------
// factory
// ----------------------------------------------------------------------------
export function createNeweggClient(config: NeweggClientConfig): NeweggClient;

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

export interface NeweggClientConfig {
  sellerId: string;
  apiKey: string;
  secretKey: string;
  marketplace: NeweggMarketplace;
  /**
   * The marketplace the key pair was issued under. Newegg authenticates on sellerId + keys only and ignores
   * the URL prefix, so keys from another marketplace's seller account silently serve THAT account
   * (contracts §2). When set and different from `marketplace`, createNeweggClient throws
   * NeweggMarketplaceMismatchError before any request. Absent = no check (unsafe if they can disagree);
   * the MCP server always sets it. ADR 0006.
   */
  credentialMarketplace?: NeweggMarketplace;
  /**
   * Trusted-config-only override (tests, proxies). Never exposed via MCP tools. Must end in `/`.
   * Unless `allowCustomBaseUrl` is true it must be an `https` newegg.com host (the parsed hostname is
   * `newegg.com` or ends in `.newegg.com`) or an `http` loopback host (`127.0.0.1`, `localhost`, `::1`, for tests; `https`
   * loopback needs the flag). Any other host throws NeweggConfigurationError, because the API keys and seller ID are
   * sent to it (T-6217).
   */
  baseUrl?: string;
  /**
   * Opt in to a non-newegg.com `https` baseUrl (proxy, mock server). Default false. Accepting one logs a
   * single `warn` (`config.custom_base_url`) naming the host only. Non-loopback `http` stays refused.
   */
  allowCustomBaseUrl?: boolean;
  timeoutMs?: number; // default 30_000
  userAgent?: string; // default "newegg-marketplace-sdk/<version> node/<version>"
  retry?: RetryOptions;
  logger?: NeweggLogger;
  fetch?: typeof globalThis.fetch;
  rateLimitStore?: RateLimitStore;
  operationStore?: OperationStore;
  /** How long a timed-out or successful label create blocks a new one for the same order (ms). Whole number, 1 hour (3_600_000) to 30 days; default 24 hours. */
  labelCreateGuardWindowMs?: number;
  strategy?: {
    /** updateMany "auto" switches to feeds at > this many post-dedup items. Default 8. SDK policy, not a Newegg rule. */
    autoFeedThreshold?: number;
  };
  /** Optional app-level quantity ceiling; SDK never clamps silently — violation => NeweggValidationError. */
  maxQuantity?: number;
  /** Replaces the built-in FTP downloader of the file reports (Daily Inventory / Daily Price). Receives a credential-bearing URL: a secret. */
  reportFileDownloader?: ReportFileDownloader;
  /** Transport settings of the built-in FTP downloader (ignored when reportFileDownloader is set). Plain FTP by default; FTPS is opt-in. */
  reportFileFtp?: ReportFileFtpOptions;
}

export interface NeweggClient {
  readonly marketplace: NeweggMarketplace;
  readonly inventory: InventoryApi;
  readonly pricing: PricingApi; // Get Item Price reads (contracts §15) + gated price writes (§16)
  readonly feeds: FeedsApi;
  readonly service: ServiceApi;
  readonly orders: OrdersApi; // order reads (list / get / status) + writes (ship / cancel / confirm / remove)
  readonly rma: RmaApi; // RMA reads (contracts §18) + writes: submit / edit / process / reject (§20)
  readonly refunds: RefundsApi; // courtesy refund reads (§18) + issue (§20)
  readonly reference: ReferenceApi; // READ-only seller/category reference lookups (contracts §19)
  readonly sbn: SbnApi; // READ-only Shipped-by-Newegg inbound shipment lookups (contracts §21); Newegg.com / B2B only
  readonly shippingLabels: ShippingLabelsApi; // UPS shipping labels: estimate (single attempt, never retried), create / reprint (WRITES that spend money, contracts §23)
  readonly ads: AdsApi; // READ-only Sponsored Ads campaign / group / keyword lists + performance reports (contracts §25); Newegg.com and Newegg.ca (Business throws UnsupportedMarketplaceOperationError)
  readonly catalog: CatalogApi; // read-only catalog resolution (Item Lookup Report, contracts §12)
  readonly reports: ReportsApi; // read-only settlement / daily inventory / daily price reports (contracts §17)
  readonly listings: ListingsApi; // WRITE: existing-item listing creation (ITEM_DATA&v2 feed, contracts §13)
  readonly volumeDiscounts: VolumeDiscountsApi; // volume-discount reads + WRITE via the VOLUME_DISCOUNT_DATA feed (contracts §22); update is Newegg.ca only
  // UNOFFICIAL public storefront buy-box/offers reader (contracts §14). Unauthenticated,
  // read-only, no SLA — NOT part of the seller API. "us"/"ca" only; "b2b" throws
  // UnsupportedMarketplaceOperationError on call (never at construction).
  readonly storefront: StorefrontApi;
  // Read-only, fail-fast credential preflight (single service-status GET). Throws
  // NeweggAuthenticationError (401) / NeweggAuthorizationError (403) immediately on
  // bad or unauthorized credentials; resolves on success. Never mutates.
  verifyCredentials(options?: RequestOptions): Promise<CredentialCheck>;
}

export interface CredentialCheck {
  readonly ok: true;
  readonly marketplace: NeweggMarketplace;
  readonly domain: NeweggServiceDomain; // always "contentmgmt"
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
  correlationId?: string; // auto-generated UUID when omitted
  includeRaw?: boolean; // attach sanitized raw response payload to results (never via MCP)
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
  quantity: number; // non-negative safe integer; 0 is valid and meaningful
  warehouseLocation?: string; // ISO 3166-1 alpha-3, uppercase; required for US ops
  fulfillmentOption?: "Seller";
  metadata?: Record<string, string>; // caller bookkeeping, never sent to Newegg
}

// ----------------------------------------------------------------------------
// inventory reads
// ----------------------------------------------------------------------------
export interface GetItemInput {
  identifier: ItemIdentifier;
  warehouses?: string[]; /* US only */
}
export interface GetManyInput {
  identifiers: ItemIdentifier[];
  warehouses?: string[]; /* US only */
}

export interface WarehouseInventory {
  /** ISO alpha-3 country (US) or Newegg warehouse/SBS code (B2B/CAN breakdown). */
  location: string;
  quantity: number;
  fulfillment: "seller" | "newegg";
}
export interface InventoryItemSnapshot {
  marketplace: NeweggMarketplace;
  itemNumber?: string;
  sellerPartNumber?: string;
  condition?: ItemCondition;
  active?: boolean; // B2B/CAN only
  totalAvailableQuantity: number;
  warehouses: WarehouseInventory[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown; // only when includeRaw
}
export interface InventoryBatchSnapshot {
  marketplace: NeweggMarketplace;
  items: InventoryItemSnapshot[];
  bySellerPartNumber: ReadonlyMap<string, InventoryItemSnapshot>; // Newegg returns items unordered — resolve by key
  byItemNumber: ReadonlyMap<string, InventoryItemSnapshot>;
  missingIdentifiers: ItemIdentifier[]; // requested but not returned by Newegg
  totalCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

// ----------------------------------------------------------------------------
// inventory writes
// ----------------------------------------------------------------------------
export type InventoryUpdateStrategy = "direct" | "feed" | "auto";

export interface UpdateOptions extends RequestOptions {}
export interface UpdateManyOptions extends RequestOptions {
  strategy?: InventoryUpdateStrategy; // default "auto"
  waitForFeedCompletion?: boolean; // default false
  wait?: WaitForResultOptions; // polling knobs when waiting
  concurrency?: number; // direct-update concurrency, default 4
}
export interface PreviewOptions extends RequestOptions {
  strategy?: InventoryUpdateStrategy;
  includeCurrentInventory?: boolean; // performs reads; still zero writes
}

export interface NormalizedInventoryUpdate extends InventoryUpdate {
  inputIndex: number; // index in the caller's original array
}
export interface InventoryUpdatePreview {
  marketplace: NeweggMarketplace;
  strategy: "direct" | "feed" | "mixed";
  normalizedUpdates: NormalizedInventoryUpdate[]; // post-validation, post-dedup (last-write-wins)
  deduplicated: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }>;
  plannedFeedCount: number; // 0 when direct
  zeroQuantityCount: number;
  warnings: string[];
  currentInventory?: InventoryItemSnapshot[]; // when includeCurrentInventory
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
  tryGetItem(
    input: GetItemInput,
    options?: RequestOptions,
  ): Promise<InventoryItemSnapshot | undefined>; // undefined on CT026 (unknown item); other errors throw
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
// pricing reads (Get Item Price — contracts §15; READ-only)
// ----------------------------------------------------------------------------
export type PricePromotion =
  "priceLock" | "promotionCode" | "autoAddToCart" | "combo" | "volumeDiscount";

export interface GetPriceInput {
  identifier: ItemIdentifier;
  countries?: string[]; // US only: uppercase ISO alpha-3 filter; ignored on B2B/CAN
}
export interface GetPriceManyInput {
  identifiers: ItemIdentifier[]; // 1–100 (SDK policy); duplicates are read once
  countries?: string[]; // US only
}
export interface GetPriceManyOptions extends RequestOptions {
  concurrency?: number; // bounded parallelism of the per-item reads; default 4
}

export interface PriceEntry {
  countryCode?: string; // US only (ISO alpha-3)
  currency?: string; // US: from Newegg. B2B/CAN: inferred (b2b USD, ca CAD) — see currencyInferred
  currencyInferred: boolean;
  active?: boolean;
  msrp?: number; // documented but absent from sample payloads (contracts §15.2 ASSUMPTION)
  map?: number; // 0/absent = none; ignored when checkoutMap
  checkoutMap?: boolean;
  sellingPrice?: number;
  freeShipping?: boolean; // EnableFreeShipping
  promotions: PricePromotion[]; // OnPromotion codes 1–5 ("0"/unknown codes yield nothing)
  limitQuantity?: number; // per-customer 48 h cap, max 500
}
export interface ItemPriceSnapshot {
  marketplace: NeweggMarketplace;
  itemNumber?: string;
  sellerPartNumber?: string;
  shippedByNewegg?: boolean; // B2B/CAN only (ShipByNewegg)
  prices: PriceEntry[]; // US: one per destination country; B2B/CAN: exactly one
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown; // only when includeRaw
}
export interface PriceReadFailure {
  identifier: ItemIdentifier;
  errorCode?: string;
  httpStatus?: number;
  message: string;
}
export interface PriceBatchSnapshot {
  marketplace: NeweggMarketplace;
  items: ItemPriceSnapshot[]; // request order, de-duplicated
  bySellerPartNumber: ReadonlyMap<string, ItemPriceSnapshot>;
  byItemNumber: ReadonlyMap<string, ItemPriceSnapshot>;
  missingIdentifiers: ItemIdentifier[]; // CT026 / CT010
  failures: PriceReadFailure[]; // any other per-item error; the rest of the batch still returns
  totalCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface PricingApi {
  get(input: GetPriceInput, options?: RequestOptions): Promise<ItemPriceSnapshot>;
  tryGet(input: GetPriceInput, options?: RequestOptions): Promise<ItemPriceSnapshot | undefined>; // undefined on CT026/CT010
  // Fans out single Get Item Price reads (the batch-price pages are unreadable — contracts §15.4).
  // Auth/authorization errors, exhausted rate limits and aborts still throw.
  getMany(input: GetPriceManyInput, options?: GetPriceManyOptions): Promise<PriceBatchSnapshot>;
  // Price WRITES (contracts §16) — see the types below. previewUpdate only reads.
  previewUpdate(
    updates: PriceUpdate | PriceUpdate[],
    options?: PreviewPriceOptions,
  ): Promise<PriceUpdatePreview>;
  update(
    updates: PriceUpdate | PriceUpdate[],
    options?: UpdatePricesOptions,
  ): Promise<PriceUpdateResult>; // WRITE
}

// pricing writes (contracts §16) — WRITE surface; only SellingPrice is ever sent
export interface PriceUpdate {
  identifier: ItemIdentifier;
  sellingPrice: number; // absolute; > 0, <= 99999.99, max 2 decimals (never rounded or clamped)
  countryCode?: string; // US only, REQUIRED there (uppercase alpha-3); rejected on B2B/CA
  currency?: string; // US only, REQUIRED there (ISO 4217, must match the country); rejected on B2B/CA
  metadata?: Record<string, string>; // never sent to Newegg
}
export interface NormalizedPriceUpdate extends PriceUpdate {
  inputIndex: number;
}
export interface PreviewPriceOptions extends RequestOptions {
  includeCurrentPrice?: boolean;
} // default true
export type PriceChangeStatus = "ok" | "warning" | "blocked" | "unchecked";
export interface PriceChange {
  inputIndex: number;
  identifier: ItemIdentifier;
  countryCode?: string;
  currency?: string;
  newSellingPrice: number;
  currentSellingPrice?: number;
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
  normalizedUpdates: NormalizedPriceUpdate[]; // post-validation, post-dedup (last-write-wins)
  deduplicated: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }>;
  changes: PriceChange[];
  warnings: string[];
  correlationId: string;
}
export interface UpdatePricesOptions extends RequestOptions {
  verify?: boolean; // read each price back after the write; default true
  concurrency?: number; // default 2
}
export type PriceOutcomeStatus = "verified" | "accepted" | "unverified" | "unknown" | "failed";
export interface PriceUpdateOutcome {
  inputIndex: number;
  identifier: ItemIdentifier;
  countryCode?: string;
  requestedSellingPrice: number;
  status: PriceOutcomeStatus;
  observedSellingPrice?: number;
  errorCode?: string;
  message?: string;
}
export interface PriceUpdateResult {
  operationId: string;
  correlationId: string;
  marketplace: NeweggMarketplace;
  submittedItemCount: number;
  appliedItemCount: number; // verified + accepted
  failedItemCount: number;
  unresolvedItemCount: number; // unverified + unknown
  deduplicatedItemCount: number;
  items: PriceUpdateOutcome[];
  warnings: string[];
  rateLimit?: RateLimitInfo;
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
  requestType: string; // INVENTORY_DATA | INVENTORY_AND_PRICE_DATA
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
  records: FeedResultRecord[]; // detailed records (Newegg details failures/warnings)
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface WaitForResultOptions extends RequestOptions {
  pollingIntervalMs?: number; // default 5_000
  maxPollingIntervalMs?: number; // default 60_000 (bounded exponential)
  timeoutMs?: number; // default 900_000; polling never runs unbounded
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
  getStatus(domain?: NeweggServiceDomain, options?: RequestOptions): Promise<ServiceStatus>; // default "contentmgmt"
}

// ----------------------------------------------------------------------------
// orders (read-only) — newegg-api-contracts.md §10
// ----------------------------------------------------------------------------
// Wire codes normalize to these unions; an unrecognized code becomes "unknown" (never throws).
export type OrderStatus =
  | "unshipped"
  | "partiallyShipped"
  | "shipped"
  | "invoiced"
  | "voided"
  | "paymentPending"
  | "unknown";
export type OrderItemStatus = "unshipped" | "shipped" | "cancelled" | "unknown"; // item scale (1/2/3)
export type OrderSalesChannel = "newegg" | "multiChannel" | "replacement" | "nws" | "unknown";
export type OrderFulfillment = "seller" | "newegg"; // FulfillmentOption 0/1
export type OrderTypeFilter = "all" | "sbn" | "sbs" | "multiChannel" | "nws"; // Type filter
export type PremierOrderFilter = "all" | "premierOnly" | "noPremier";

export interface ListOrdersInput {
  orderNumbers?: Array<string | number>; // direct lookup; Newegg ignores other criteria when set
  sellerOrderNumbers?: string[];
  status?: OrderStatus; // concrete status only; "unknown" or any unrecognized value => NeweggValidationError, never dropped
  type?: OrderTypeFilter; // default "all" on the wire; "nws" is us-only (throws UnsupportedMarketplaceOperationError on ca/b2b)
  includeDownloaded?: boolean; // false => exclude already-downloaded (OrderDownloaded=1)
  premierOrder?: PremierOrderFilter; // us-only: throws UnsupportedMarketplaceOperationError on ca/b2b, nothing sent
  dateFrom?: Date | string; // Date => rendered Pacific; string sent verbatim, so it must be a real Pacific `MM/DD/YYYY HH:mm:ss` or `YYYY-MM-DD HH:mm:ss` (both forms verified live on ca 2026-10-21) or NeweggValidationError
  dateTo?: Date | string; // same rule as dateFrom
  countryCode?: string; // ISO 3-digit ship-to; us-only: throws UnsupportedMarketplaceOperationError on ca/b2b, nothing sent; empty or whitespace-padded => NeweggValidationError on every marketplace (checked first, never trimmed)
  lastUpdatedAfter?: Date | string; // LastUpdatedAfter, all marketplaces; Date => Pacific, string verbatim (ASSUMPTION: filters on last update)
  isInternal?: boolean; // IsInternal sent as 1/0, all marketplaces; semantics UNDOCUMENTED/UNVERIFIED (non-boolean => NeweggValidationError)
  page?: number; // PageIndex, default 1
  pageSize?: number; // PageSize, max 100, default 100
}

export interface ShipToAddress {
  // every field is "" for voided orders (observed for a voided order on ca, one order, 2026-10-21)
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
  emailAddress?: string; // masked Newegg relay (…@marketplace.newegg.com), never the real email
  shipTo?: ShipToAddress;
}
export interface OrderAmounts {
  // each a decimal in Order.currencyCode
  itemAmount?: number;
  shippingAmount?: number; // 0 for voided orders (observed for a voided order on ca, one order, 2026-10-21)
  discountAmount?: number;
  refundAmount?: number;
  salesTax?: number;
  vatTotal?: number;
  dutyTotal?: number;
  recyclingFee?: number;
  total?: number; // OrderTotalAmount
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
  extendedUnitPrice?: number; // ExtendUnitPrice
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
export interface Order {
  orderNumber: string; // always a string (wire is number-or-string)
  sellerOrderNumber?: string;
  invoiceNumber?: string;
  status: OrderStatus;
  statusDescription?: string;
  downloaded?: boolean;
  orderDate?: { raw: string; iso?: string };
  autoVoidTime?: { raw: string; iso?: string };
  isAutoVoid?: boolean;
  salesChannel?: OrderSalesChannel;
  fulfillment?: OrderFulfillment;
  currencyCode?: string; // the key owner's account currency: CAD on ca; USD on us/b2b is an ASSUMPTION (contracts §10)
  customer?: OrderCustomer;
  shipService?: string; // "" (empty) for voided orders (observed for a voided order on ca, one order, 2026-10-21)
  signatureRequired?: boolean;
  onTimeShipDueDate?: { raw: string; iso?: string };
  deliverDueDate?: { raw: string; iso?: string };
  amounts: OrderAmounts;
  quantity?: number; // OrderQty
  items: OrderItem[];
  packages: OrderPackage[];
}
export interface OrdersPage {
  marketplace: NeweggMarketplace;
  orders: Order[];
  page: number; // echoed PageIndex
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface OrderStatusSnapshot {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  status: OrderStatus;
  statusName?: string; // Newegg's camel-case OrderStatusName
  downloaded?: boolean;
  salesChannel?: OrderSalesChannel;
  fulfillment?: OrderFulfillment;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface ShipPackageItem {
  sellerPartNumber: string;
  shippedQty: number; // > 0
  neweggItemNumber?: string;
}
export interface ShipPackage {
  trackingNumber: string;
  shipCarrier: string; // Newegg Integrated Carrier List value
  shipService: string;
  items: ShipPackageItem[];
}
export interface ShipOrderInput {
  orderNumber: string | number;
  packages: ShipPackage[];
}
export interface ShipPackageResult {
  trackingNumber?: string;
  shipDate?: { raw: string; iso?: string };
  processStatus: boolean; // authoritative per-package outcome (envelope IsSuccess is NOT)
  processResult?: string;
  items: Array<{ sellerPartNumber?: string; neweggItemNumber?: string; shippedQty?: number }>;
}
export interface ShipOrderResult {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  status: OrderStatus; // normalized from "Shipped" / "PartiallyShipped"
  statusLabel?: string;
  totalPackageCount: number;
  successCount: number;
  failCount: number; // > 0 => partial failure; inspect packages[].processStatus
  packages: ShipPackageResult[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export type CancelReason = "outOfStock" | "customerRequested" | "priceError" | "unableToFulfill"; // 24/72/73/74
export interface CancelOrderInput {
  orderNumber: string | number;
  reason: CancelReason;
}
export type CancelOrderOutcome = "void" | "processing" | "unknown"; // processing = SBN, poll separately
export interface CancelOrderResult {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  outcome: CancelOrderOutcome;
  outcomeLabel?: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface ConfirmOrdersInput {
  orderNumbers: Array<string | number>;
  issueUser?: string;
}
export interface ConfirmOrdersResult {
  marketplace: NeweggMarketplace;
  orderNumbers: string[]; // echoed downloaded list
  requestDate?: { raw: string; iso?: string };
  responseDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface RemoveOrderItemsInput {
  orderNumber: string | number;
  sellerPartNumbers: string[]; // unique
  memo?: string;
  issueUser?: string;
}
export interface RemoveOrderItemsResult {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  removedSellerPartNumbers: string[];
  memo?: string; // error description when the op failed
  requestDate?: { raw: string; iso?: string };
  responseDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface OrdersApi {
  list(input?: ListOrdersInput, options?: RequestOptions): Promise<OrdersPage>; // Get Order Information
  get(orderNumber: string | number, options?: RequestOptions): Promise<Order>; // throws if not found
  tryGet(orderNumber: string | number, options?: RequestOptions): Promise<Order | undefined>;
  getStatus(orderNumber: string | number, options?: RequestOptions): Promise<OrderStatusSnapshot>; // throws SO003; may also fail with SO003 for a voided order (observed for a voided order on ca, one order, 2026-10-21)
  tryGetStatus(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<OrderStatusSnapshot | undefined>; // SO003 => undefined
  // Get Additional Order Information (contracts §24; a POST READ; Newegg.com only, b2b/ca throw UnsupportedMarketplaceOperationError)
  listAdditionalInfo(
    input?: ListAdditionalOrderInfoInput,
    options?: RequestOptions,
  ): Promise<AdditionalOrderInfoPage>;
  getAdditionalInfo(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<AdditionalOrderInfo>; // throws if none
  tryGetAdditionalInfo(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<AdditionalOrderInfo | undefined>;
  // writes — NON-idempotent; an ambiguous transport failure throws IndeterminateOrderWriteError (no retry)
  ship(input: ShipOrderInput, options?: RequestOptions): Promise<ShipOrderResult>; // Action 2
  cancel(input: CancelOrderInput, options?: RequestOptions): Promise<CancelOrderResult>; // Action 1
  confirmDownload(
    input: ConfirmOrdersInput,
    options?: RequestOptions,
  ): Promise<ConfirmOrdersResult>;
  removeItems(
    input: RemoveOrderItemsInput,
    options?: RequestOptions,
  ): Promise<RemoveOrderItemsResult>; // KillItem
}

// ----------------------------------------------------------------------------
// catalog (item lookup / resolution — contracts §12; READ-only, incl. report submission)
// ----------------------------------------------------------------------------
export type CatalogLookupInput =
  | { neweggItemNumber: string } // passthrough: already resolved, no API call
  | { upc: string; condition?: ItemCondition; packsOrSets?: number }
  | {
      manufacturer: string;
      manufacturerPartNumber: string;
      condition?: ItemCondition;
      packsOrSets?: number;
    };

export interface CatalogMatch {
  neweggItemNumber: string;
  upc?: string;
  condition?: ItemCondition;
  packsOrSets?: number;
  manufacturer?: string;
  manufacturerPartNumber?: string;
  websiteShortTitle?: string; // Newegg catalog title — confirm the match is the intended product
}

export interface CatalogResolution {
  input: CatalogLookupInput;
  found: boolean;
  matches: CatalogMatch[];
}

export interface ResolveCatalogOptions {
  correlationId?: string;
  signal?: AbortSignal;
  includeRaw?: boolean;
  timeoutMs?: number; // overall submit+poll+result budget; default 120_000
  pollIntervalMs?: number; // first poll delay; default 2_000, grows 1.5x per poll
  maxPollIntervalMs?: number; // poll delay ceiling; default 15_000
}

export interface ResolveCatalogResult {
  marketplace: NeweggMarketplace;
  requestId?: string; // absent when every input was a neweggItemNumber passthrough
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

export type CatalogLookupState = "submitted" | "inProgress" | "finished" | "cancelled" | "unknown";

export interface CatalogLookupStatus {
  marketplace: NeweggMarketplace;
  requestId: string;
  status: CatalogLookupState;
  statusRaw?: string; // Newegg's literal string when status is "unknown"
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

export interface CatalogApi {
  // One-call facade: submit → poll → all result pages → per-input resolutions. Throws
  // CatalogLookupTimeoutError (carrying requestId) if not FINISHED within timeoutMs —
  // continue with lookupStatus/lookupResult instead of resubmitting (submit is 100/hr).
  resolve(
    input: CatalogLookupInput | CatalogLookupInput[],
    options?: ResolveCatalogOptions,
  ): Promise<ResolveCatalogResult>;
  // Max 1000 items (RP021). Rejects neweggItemNumber inputs with NeweggValidationError.
  submitLookup(
    inputs: CatalogLookupInput[],
    options?: RequestOptions,
  ): Promise<CatalogLookupSubmission>;
  lookupStatus(requestId: string, options?: RequestOptions): Promise<CatalogLookupStatus>;
  lookupResult(
    requestId: string,
    page?: number,
    options?: RequestOptions,
  ): Promise<CatalogLookupResultPage>;
}

// Error (exported class, code "catalog_lookup_timeout", retryable true on timeout /
// false on CANCELLED): carries readonly requestId.
export class CatalogLookupTimeoutError extends NeweggError {
  readonly requestId: string;
}

// ----------------------------------------------------------------------------
// reports (Reports Management reads — contracts §17; READ-only, incl. report submission)
// ----------------------------------------------------------------------------
// Settlement Summary / Settlement Transaction (paged inline JSON) and Daily Inventory / Daily Price
// (a file fetched over FTP). Shares the reportmgmt submit→status→result lifecycle with catalog.
// The FTP report-file URL embeds credentials: it is NEVER exposed (not in results, errors, `raw`
// or logs) — `ReportFileInfo` carries only host + file name, `raw` is redacted.
export type ReportState = "submitted" | "inProgress" | "finished" | "cancelled" | "unknown"; // CatalogLookupState = ReportState

// A string is sent as given (YYYY-MM-DD or a Pacific date-time); a Date is rendered as its
// PACIFIC calendar date (YYYY-MM-DD). Invalid/impossible/inverted dates -> NeweggValidationError.
export type ReportDateInput = string | Date;

// Replaces the built-in FTP downloader (default: passive-mode FTP to *.newegg.com only, size caps).
// Receives the credential-bearing URL — treat as a secret. NeweggClientConfig.reportFileDownloader.
export type ReportFileDownloader = (
  url: string,
  options: { signal?: AbortSignal; maxBytes: number; timeoutMs: number },
) => Promise<Uint8Array>;

// Built-in downloader: plain FTP by default; URL port 21 only, *.newegg.com only, control channel capped at
// 64 KiB/line and 256 KiB/reply. ftps opts in to explicit FTPS (AUTH TLS before USER/PASS, PROT P, no fallback to
// clear text; the transfer must also be length-checked with SIZE); Newegg's certificate is Serv-U's stock
// self-signed one, so pin it (contracts §17.5: the pin stops passive eavesdropping, probably not an active MITM).
export interface ReportFileFtpOptions {
  ftps?: boolean; // opt in to explicit FTPS; off by default
  tlsPinnedCertSha256?: string; // SHA-256 fingerprint (hex) the certificate must have; replaces the host name check; needs tlsCa
  allowedPorts?: number[]; // default [21]
  tlsCa?: string | string[]; // extra trusted CA certificate(s), PEM (the server's own PEM for a self-signed cert); verification is never disabled
}

export interface ReportSubmission {
  marketplace: NeweggMarketplace;
  requestId: string;
  requestType?: string;
  requestDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown; // sanitized
}
export interface ReportStatus {
  marketplace: NeweggMarketplace;
  requestId: string;
  status: ReportState;
  statusRaw?: string;
  requestType?: string;
  totalCount?: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface ReportWaitOptions {
  correlationId?: string;
  signal?: AbortSignal;
  includeRaw?: boolean;
  // poll budget: default 300_000 for settlementSummary / settlementTransactions (a Settlement
  // Summary took ~170 s live, contracts §17) and for itemBasicInfo / orderList / rmaList (~140-260 s
  // live), 120_000 for dailyInventory / dailyPrice; an
  // explicit value always wins. On timeout, ReportTimeoutError.requestId lets you continue.
  timeoutMs?: number;
  pollIntervalMs?: number; // default 2_000, x1.5 per poll
  maxPollIntervalMs?: number; // default 15_000
  maxPages?: number; // paged reports, 100 rows/page, default 50
  maxRows?: number; // file reports: parsed rows kept, default 50_000 (all are counted)
}
export interface ReportResultPage<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  rows: Row[];
  page: number; // 1-based
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  requestDate?: { raw: string; iso?: string };
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface CollectedReport<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  rows: Row[];
  totalCount: number;
  pagesFetched: number;
  truncated: boolean; // maxPages stopped the fetch early
  correlationId: string;
}
export interface ReportResultOptions extends RequestOptions {
  version?: string; // settlement summary only; default "313" (ASSUMPTION: accepted on all platforms)
}

export interface SettlementSummaryInput {
  dateFrom: ReportDateInput;
  dateTo: ReportDateInput;
}
// Amount fields (numbers; USD on .com/Business, CAD on .ca). Absent = not reported, never zero.
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
export type SettlementSummaryRow = {
  settlementDate?: { raw: string; iso?: string };
  settlementDateFrom?: { raw: string; iso?: string };
  settlementDateTo?: { raw: string; iso?: string };
  settlementId?: string;
  checkNumber?: string;
  memo?: string;
  unmapped?: Record<string, string>; // wire fields this SDK version does not map
} & { [K in SettlementSummaryAmountField]?: number };

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
  | "itemOverageFee"; // wire codes 0-32, contracts §17.3
// Newegg requires settlementId, settlementDate, or BOTH settlementDateFrom and settlementDateTo
// (RP020); the SDK enforces it before sending (NeweggValidationError).
export interface SettlementTransactionsInput {
  settlementDateFrom?: ReportDateInput;
  settlementDateTo?: ReportDateInput;
  settlementDate?: ReportDateInput;
  settlementId?: string | number;
  orderNumber?: string | number;
  transactionType?: SettlementTransactionType; // default "all"
}
export interface SettlementTransactionRow {
  transactionDate?: { raw: string; iso?: string };
  transactionType?: string;
  orderNumber?: string;
  invoiceNumber?: string;
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  itemDescription?: string;
  itemCondition?: string;
  amount?: number;
  shipping?: number;
  commissionFee?: number;
  settlementId?: string;
  memo?: string;
}

// Settlement paged reports: submit / status / result(page) / waitForRequest / waitForResult, i.e.
// the generic `PagedReportApi<Input, Row>` declared further below (waitFor* throw
// ReportTimeoutError, carrying requestId, on timeout/cancel).
export interface SettlementSummaryReportApi {
  submit(input: SettlementSummaryInput, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  result(
    requestId: string,
    page?: number,
    options?: ReportResultOptions,
  ): Promise<ReportResultPage<SettlementSummaryRow>>;
  waitForRequest(
    requestId: string,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<SettlementSummaryRow>>;
  waitForResult(
    input: SettlementSummaryInput,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<SettlementSummaryRow>>;
}
export interface SettlementTransactionReportApi {
  submit(input: SettlementTransactionsInput, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  result(
    requestId: string,
    page?: number,
    options?: ReportResultOptions,
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

export type ReportTextFileType = "csv" | "txt"; // default "csv" (XLS is not parsed)
export interface ReportFileInfo {
  marketplace: NeweggMarketplace;
  requestId: string;
  available: boolean; // false when the result carried no file URL yet
  fileName?: string;
  host?: string; // the credential-bearing URL is withheld
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown; // user:pass@ redacted
}
export interface DownloadedReport<Row> {
  marketplace: NeweggMarketplace;
  requestId: string;
  fileName?: string;
  rows: Row[]; // capped at maxRows
  totalRows: number;
  truncated: boolean;
  fileCount: number; // > 1 for a zip package (> 40,000 items)
  correlationId: string;
}
export interface DailyInventoryInput {
  fulfillType?: "all" | "seller" | "newegg";
  warehouses?: string[]; // US only (3-letter ISO); rejected on b2b/ca
  fileType?: ReportTextFileType;
}
// US: warehouseLocation + inventory + fulfillmentOption. B2B/CA: default warehouse with
// currency/msrp/map/checkoutMap/sellingPrice/shipping/activationMark. Unmapped columns -> extra.
export interface DailyInventoryRow {
  sellerPartNumber?: string;
  neweggItemNumber?: string;
  warehouseLocation?: string;
  fulfillmentOption?: string;
  inventory?: number;
  currency?: string;
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  sellingPrice?: number;
  shipping?: string;
  activationMark?: boolean;
  memo?: string;
  extra?: Record<string, string>;
}
export interface DailyPriceInput {
  countries?: string[]; // 3-letter ISO, default all
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
  shipping?: string;
  activationMark?: boolean;
  memo?: string;
  extra?: Record<string, string>;
}
export interface FileReportApi<Input, Row> {
  submit(input: Input, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  result(requestId: string, options?: RequestOptions): Promise<ReportFileInfo>;
  download(requestId: string, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
  waitForRequest(requestId: string, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
  waitForResult(input: Input, options?: ReportWaitOptions): Promise<DownloadedReport<Row>>;
}

// -- Item Basic Information (file; contracts §17.8) ------------------------------------------
// The only way to enumerate every listing. Carries NO price/inventory: join dailyInventory on
// sellerPartNumber. Live-verified on CAN 2026-10-10 (zip, FTP host mktpftpreport.newegg.com).
export type ItemBasicInfoStatus = "all" | "active" | "inactive"; // wire 0 / 1 / 2, default "all"
export interface ItemBasicInfoInput {
  status?: ItemBasicInfoStatus;
  fileType?: ReportTextFileType;
}
export interface ItemVarietyOption {
  name: string;
  value: string;
}
export interface ItemBasicInfoRow {
  sellerPartNumber?: string; // "Seller Part #" - the SKU
  neweggItemNumber?: string; // "NE Item #"
  manufacturerPartNumber?: string;
  upc?: string; // absent for listings without a UPC
  status?: string; // verbatim "Active" / "Inactive"
  active?: boolean;
  title?: string; // Newegg's header is misspelled "Wesite Short Title"; both spellings read
  industry?: string;
  subcategory?: string;
  bulletDescription?: string;
  itemLength?: number; // units undocumented
  itemWidth?: number;
  itemHeight?: number;
  itemWeight?: number;
  imageUrls?: string[]; // "Item Image" is comma-separated
  dateCreated?: string; // YYYY-MM-DD (file gives MM/DD/YYYY; month-first ASSUMPTION)
  platform?: string; // e.g. "CAN"
  itemGroupId?: string; // variant family
  varieties?: ItemVarietyOption[]; // up to 3 custom variety options
  extra?: Record<string, string>; // unmapped columns
}

// -- Order List / RMA List (paged inline; contracts §17.6) -------------------------------------
// Rows are the SAME `Order` / `Rma` shapes as orders.list / rma.list (customer block = PII; the MCP
// tools never return it). `version` is required on the wire: defaults 309 (orders) / 320 (RMAs),
// validated against the platform's documented set (platform/reports.ts).
export interface PagedReportApi<Input, Row> {
  submit(input: Input, options?: RequestOptions): Promise<ReportSubmission>;
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>;
  result(
    requestId: string,
    page?: number,
    options?: ReportResultOptions,
  ): Promise<ReportResultPage<Row>>;
  waitForRequest(
    requestId: string,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<Row>>;
  waitForResult(
    input: Input,
    options?: ReportWaitOptions & { version?: string },
  ): Promise<CollectedReport<Row>>;
}
export type OrderListKeywordType =
  | "orderNumber"
  | "invoiceNumber"
  | "customerName"
  | "sellerPartNumber"
  | "neweggItemNumber"
  | "customerPhoneNumber"
  | "titleDescription"
  | "manufacturer"
  | "sellerOrderNumber"; // KeywordsType 1-9
export interface OrderListInput {
  status: Exclude<OrderStatus, "unknown">; // REQUIRED by Newegg (Status 0-5)
  keyword?: { type: OrderListKeywordType; value: string };
  type?: Exclude<OrderTypeFilter, "nws">; // default "all"
  dateFrom?: Date | string; // Pacific; YYYY-MM-DD or M/D/YYYY H:mm[:ss]
  dateTo?: Date | string;
  voidSoon?: 24 | 48;
  includeDownloaded?: boolean; // false -> wire OrderDownloaded "true" (Newegg's flag is inverted)
  countryCode?: string; // Newegg.com only, 3-letter ISO; rejected on b2b/ca
  premierOrder?: PremierOrderFilter; // Newegg.com only; rejected on b2b/ca
}
export interface RmaListInput {
  keyword?: { type: RmaKeywordType; value: string };
  status?: Exclude<RmaStatus, "unknown">;
  type?: Exclude<RmaType, "unknown">;
  processedBy?: RmaProcessedBy;
  dateFrom?: Date | string;
  dateTo?: Date | string;
}
// Additive fields filled by these reports (and by Get Order/RMA Information when present):
//   OrderAmounts.gstOrHstAmount / pstOrQstAmount / ehfAmount (Newegg.ca), OrderPackage.items[]
//   (package lines nested under PackageInfo.ItemInfoList), Rma.refundGstOrHstAmount /
//   refundPstOrQstAmount (Newegg.ca), RmaItem.rmaTotalRefund (RefundInfo.RMATotalRefund).

export interface ReportsApi {
  readonly settlementSummary: SettlementSummaryReportApi; // all platforms
  readonly settlementTransactions: SettlementTransactionReportApi; // all platforms
  readonly itemBasicInfo: FileReportApi<ItemBasicInfoInput, ItemBasicInfoRow>; // all platforms (identical request)
  readonly orderList: PagedReportApi<OrderListInput, Order>; // all platforms (country/Premier criteria: Newegg.com only)
  readonly rmaList: PagedReportApi<RmaListInput, Rma>; // all platforms
  readonly dailyInventory: FileReportApi<DailyInventoryInput, DailyInventoryRow>; // all platforms (US per-warehouse; b2b/ca default warehouse)
  readonly dailyPrice: FileReportApi<DailyPriceInput, DailyPriceRow>; // Newegg.com only; b2b/ca throw UnsupportedMarketplaceOperationError
  status(requestId: string, options?: RequestOptions): Promise<ReportStatus>; // any report type
}

// Error (exported class, code "report_timeout", retryable true on timeout / false on CANCELLED):
// carries readonly requestId — continue with status/waitForRequest, never resubmit (100/hour).
export class ReportTimeoutError extends NeweggError {
  readonly requestId: string;
}

// ----------------------------------------------------------------------------
// RMA and courtesy refunds (Service Management reads — contracts §18; writes — §20)
// ----------------------------------------------------------------------------
// Get RMA Information (PUT, 1000/hr), Get Courtesy Refund Information (PUT, 30/min) and Get
// Courtesy Refund Request Status (PUT, 10,000/hr) - READS despite the verb. Submit / Edit /
// Process / Reject RMA and Issue Courtesy Refund are WRITES (types further down; the live read-only
// guard forbids them). Amounts are USD (us, b2b) or CAD (ca): see `currency`.
// Criteria dates (RMA / refund `dateFrom` `dateTo`, SBN `updatedFrom` `updatedTo` `requestDateFrom`
// `requestDateTo`): a `Date` renders as Pacific wall clock; a string is sent verbatim but must be a real
// Pacific date in `YYYY-MM-DD HH:mm[:ss]`, `MM/DD/YYYY HH:mm[:ss]` or a bare `YYYY-MM-DD` (checked by
// platform/dates.ts `isPacificWallClockString`, shared with orders). Epoch digits, free text, the ISO `T`
// form, a bare `MM/DD/YYYY` and impossible dates throw NeweggValidationError before any request.
// The MCP tools pass a zone-less string through unchanged (Pacific), turn only a `Z` / offset instant into
// a `Date`, and expand a bare YYYY-MM-DD to 00:00:00 (lower bound) or 23:59:59 (upper bound); the
// machine's time zone never shifts the window. Like the orders tool, a zone-less `T` form or a bare
// `MM/DD/YYYY` is refused by the SDK rather than normalised.
export type RmaCurrency = "USD" | "CAD";
export type RmaStatus =
  "open" | "received" | "rejected" | "voided" | "closed" | "processing" | "unknown";
export type RmaType = "replacement" | "refund" | "unknown";
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
export interface ListRmasInput {
  keyword?: {
    type: "rmaNumber" | "orderNumber" | "customerName" | "sellerRmaNumber";
    value: string;
  };
  status?: Exclude<RmaStatus, "unknown">;
  type?: "replacement" | "refund";
  processedBy?: "seller" | "newegg";
  dateFrom?: Date | string; // Pacific; a Date is rendered "YYYY-MM-DD HH:mm:ss", a string is sent verbatim
  dateTo?: Date | string;
  page?: number; // 1-based, default 1
  pageSize?: number; // 1-100, default 100 (invalid values throw NeweggValidationError, never clamped)
  version?: string; // us 307|309|320, b2b/ca 305|309|320; default "320"; others throw
}
export interface RmaItem {
  sellerPartNumber?: string;
  mfrPartNumber?: string;
  neweggItemNumber?: string;
  description?: string;
  unitPrice?: number;
  returnQuantity?: number;
  returnUnitPrice?: number;
  refundShippingPrice?: number;
  shippedBy?: "seller" | "newegg";
  reason: RmaReason;
  reasonCode?: number;
  reasonDescription?: string;
  unopened?: boolean;
  memo?: string; // unopened / memo: USA and CAN only
}
export interface Rma {
  rmaNumber: string;
  type: RmaType;
  typeDescription?: string;
  sellerRmaNumber?: string;
  replacementOrderNumber?: string;
  issueUser?: string;
  rmaDate?: { raw: string; iso?: string };
  status: RmaStatus;
  statusDescription?: string;
  shipMethod?: number;
  shipMethodDescription?: string;
  orderNumber?: string;
  orderDate?: { raw: string; iso?: string };
  invoiceNumber?: string;
  orderAmount?: number;
  availableRefundAmount?: number;
  priorRefundAmount?: number;
  processedBy?: "seller" | "newegg";
  receiveDate?: { raw: string; iso?: string };
  note?: string;
  customer?: RmaCustomer; // PII (name, phone, masked e-mail, ship-to) - the MCP tools never return it
  returnLabel?: {
    trackingNumber?: string;
    trackingUrl?: string;
    estimatedCost?: number;
    paidBy?: string;
  };
  items: RmaItem[];
}
export interface RmasPage {
  marketplace: NeweggMarketplace;
  rmas: Rma[];
  currency: RmaCurrency;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface RmaApi {
  list(input?: ListRmasInput, options?: RequestOptions): Promise<RmasPage>; // empty page, not an error, when none
  get(rmaNumber: string | number, options?: RequestOptions): Promise<Rma>; // NeweggApiError when none; digits only
  tryGet(rmaNumber: string | number, options?: RequestOptions): Promise<Rma | undefined>;
  // WRITES (non-idempotent, never auto-retried after dispatch; ambiguous -> IndeterminateServiceWriteError).
  // Each preview* only READS the order / RMAs / courtesy refunds; the write re-runs the same checks and
  // throws NeweggValidationError on any blocker BEFORE sending.
  previewSubmit(
    input: SubmitRmaInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<SubmitRmaInput>>;
  submit(input: SubmitRmaInput, options?: RequestOptions): Promise<RmaWriteResult>; // 100 req/hr
  previewEdit(
    input: EditRmaInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<EditRmaInput>>;
  edit(input: EditRmaInput, options?: RequestOptions): Promise<RmaWriteResult>; // 1000 req/hr
  previewProcess(
    input: ProcessRmaInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<ProcessRmaInput>>;
  process(input: ProcessRmaInput, options?: RequestOptions): Promise<RmaWriteResult>; // receive; 1000 req/hr
  previewReject(
    input: RejectRmaInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<RejectRmaInput>>;
  reject(input: RejectRmaInput, options?: RequestOptions): Promise<RmaWriteResult>; // 1000 req/hr
}

// RMA and courtesy refund WRITES (contracts §20). Every write has a read-only preview twin;
// money is a 2-decimal number (never rounded, never clamped); input is strict (zod 4).
export type RmaWriteReason =
  | "itemDamaged"
  | "defective"
  | "incompatible"
  | "noLongerNeeded"
  | "notAsDescribed"
  | "orderedWrongItem"
  | "sentWrongItem"
  | "unsatisfied"
  | "extraItemShipped"
  | "itemNotReceived";
export interface RmaWriteItem {
  sellerPartNumber: string;
  returnQuantity: number;
  reason: RmaWriteReason;
  returnUnitPrice?: number; // refund RMA: required, > 0; replacement: forbidden
  refundShippingPrice?: number; // refund RMA: required, >= 0 (0 = none); replacement: forbidden
  unopened?: boolean; // required for incompatible / noLongerNeeded / orderedWrongItem / unsatisfied
  imageUrls?: string[]; // 1-5 https URLs without user:password@; US and CA only (B2B: validation error)
  memo?: string; // <= 1000; US and CA only
}
export interface SubmitRmaInput {
  orderNumber: string | number;
  type: "refund" | "replacement";
  items: RmaWriteItem[]; // 1-50, unique sellerPartNumber
  sellerRmaNumber?: string; // letters and digits, <= 50
  note?: string; // <= 4000
  autoReceive?: boolean; // AutoReceiveMark=1, refund RMAs only; NOT exposed by the MCP
}
export interface EditRmaInput {
  rmaNumber: string | number;
  type: "refund" | "replacement";
  note: string;
  items: RmaWriteItem[];
  sellerRmaNumber?: string;
}
export interface ProcessRmaInput {
  rmaNumber: string | number;
} // mark received
export type RmaRejectReason =
  | "physicalDamage"
  | "itemMissing"
  | "wrongItemReturned"
  | "cpuPinDamage"
  | "missingRetailBox"
  | "missingUpcCode"
  | "tamperedSerialNumber"
  | "missingAccessories"
  | "consumableItem"
  | "motherboardSocketPinDamage"
  | "qaSentWrongItem"
  | "unlockedCellphone"
  | "usedItemReturnedAsNew"
  | "customerRequest"
  | "missingSerialNumber"
  | "software";
export type RmaRejectCarrier = "ups" | "fedex" | "dhl" | "usps" | "other";
export interface RejectRmaInput {
  rmaNumber: string | number;
  reason: RmaRejectReason; // availability differs by marketplace (platform/rma.ts)
  carrier: RmaRejectCarrier;
  otherCarrier?: string; // required with carrier "other"
  shipService: string;
  trackingNumbers: string[];
  memo?: string; // required with reasons itemMissing, cpuPinDamage .. motherboardSocketPinDamage
  imageUrls?: string[]; // 1-5, required with the memo
}
export interface IssueCourtesyRefundInput {
  orderNumber: string | number;
  reason: Exclude<CourtesyRefundReason, "unknown">;
  amount: number; // > 0, <= 2 decimals, <= 99999.99, <= order total minus prior refunds
  noteToCustomer?: string; // <= 500
}
export type ServiceWriteOperation =
  "rma.submit" | "rma.edit" | "rma.receive" | "rma.reject" | "refunds.issue";
export interface ServiceWritePreview<N> {
  marketplace: NeweggMarketplace;
  operation: ServiceWriteOperation;
  normalized: N; // the exact input a write would send
  currency: RmaCurrency;
  refundTotal?: number;
  orderNumber?: string;
  blockers: string[]; // the write throws NeweggValidationError while any remain
  warnings: string[];
  correlationId: string;
}
export interface RmaWriteResult {
  marketplace: NeweggMarketplace;
  operation: Exclude<ServiceWriteOperation, "refunds.issue">;
  rmaNumber: string;
  type: RmaType;
  status: RmaStatus; // normally "processing" right after the write
  statusDescription?: string;
  sellerRmaNumber?: string;
  orderNumber?: string;
  note?: string;
  items: RmaItem[];
  currency: RmaCurrency;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface CourtesyRefundIssueResult {
  marketplace: NeweggMarketplace;
  requestId: string; // for refunds.getRequestStatus
  requestDate?: { raw: string; iso?: string };
  state: CourtesyRefundRequestState;
  stateRaw?: string;
  memo?: string;
  orderNumber: string;
  amount: number;
  currency: RmaCurrency;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export type CourtesyRefundStatus = "open" | "closed" | "void" | "unknown";
export type CourtesyRefundReason =
  | "negativeCustomerFeedback"
  | "pricingError"
  | "wrongItemInformation"
  | "shippingDelay"
  | "packageNotReceived"
  | "customerCourtesy"
  | "unknown";
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
  issuedByNewegg?: boolean;
  createdBy?: string;
  createdDate?: { raw: string; iso?: string };
  editedBy?: string;
  editedDate?: { raw: string; iso?: string };
}
export interface ListCourtesyRefundsInput {
  keyword?: { type: "courtesyRefundId" | "orderNumber" | "customerName"; value: string };
  status?: "open" | "closed" | "void";
  dateFrom?: Date | string;
  dateTo?: Date | string;
  page?: number;
  pageSize?: number; // as ListRmasInput
}
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
export type CourtesyRefundRequestState =
  "submitted" | "inProgress" | "finished" | "failed" | "cancelled" | "unknown";
export interface CourtesyRefundRequestStatus {
  requestId: string;
  requestType?: string;
  requestDate?: { raw: string; iso?: string };
  state: CourtesyRefundRequestState;
  stateRaw?: string;
  processMemo?: string; // failure detail when state is "failed"
  refund?: CourtesyRefund; // present once "finished"
}
export interface ListCourtesyRefundRequestsInput {
  requestIds?: string[]; // when set Newegg ignores every other criterion
  status?: Exclude<CourtesyRefundRequestState, "unknown">;
  dateFrom?: Date | string;
  dateTo?: Date | string;
  maxCount?: number; // 1-100, default 100
}
export interface CourtesyRefundRequestsResult {
  marketplace: NeweggMarketplace;
  requests: CourtesyRefundRequestStatus[];
  currency: RmaCurrency;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface RefundsApi {
  // WRITE: pays the customer, commission NOT refunded; asynchronous (follow with getRequestStatus).
  previewIssue(
    input: IssueCourtesyRefundInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<IssueCourtesyRefundInput>>;
  issue(
    input: IssueCourtesyRefundInput,
    options?: RequestOptions,
  ): Promise<CourtesyRefundIssueResult>; // 1000 req/hr
  list(input?: ListCourtesyRefundsInput, options?: RequestOptions): Promise<CourtesyRefundsPage>; // 30 req/min
  get(courtesyRefundId: string, options?: RequestOptions): Promise<CourtesyRefund>;
  tryGet(courtesyRefundId: string, options?: RequestOptions): Promise<CourtesyRefund | undefined>;
  listRequests(
    input?: ListCourtesyRefundRequestsInput,
    options?: RequestOptions,
  ): Promise<CourtesyRefundRequestsResult>;
  getRequestStatus(
    requestId: string,
    options?: RequestOptions,
  ): Promise<CourtesyRefundRequestStatus>;
}

// ----------------------------------------------------------------------------
// seller / category reference reads (contracts §19; READ-only, none gated)
// ----------------------------------------------------------------------------
// Seller Status Check, Get Industry List, Get Subcategory Status (+ the Newegg.com-only
// international variant), Get Subcategory Properties and Property Values. Some are PUT on the wire;
// all are reads. Get Warehouse List and Get Subcategory Status v1.1 are deliberately NOT
// implemented (no retrievable / consistent docs page, contracts §19.1).
export type SellerAccountStatus =
  "active" | "suspended" | "inactive" | "terminated" | "closed" | "unknown";
export type SellerMembership = "nonElite" | "professional" | "enterprise" | "unknown";

export interface SellerFulfillmentCenter {
  warehouseLocation?: string; // ISO alpha-3
  shippedBy?: "seller" | "newegg"; // WarehouseType 0 / 1
  shipToCountries: string[]; // ISO alpha-3
}
export interface SellerStatus {
  marketplace: NeweggMarketplace;
  sellerName?: string;
  status: SellerAccountStatus;
  statusText?: string; // Status exactly as sent
  membership?: SellerMembership; // Newegg.com only (documented version 307)
  fulfillmentCenters: SellerFulfillmentCenter[]; // Newegg.com only; [] elsewhere
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface Industry {
  code: string;
  name?: string;
}
export interface ListIndustriesInput {
  industryCode?: string; // omit for every industry; unknown code => empty list (contracts §19.3)
}
export interface IndustriesResult {
  marketplace: NeweggMarketplace;
  industries: Industry[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface ListSubcategoriesInput {
  subcategoryIds?: number[]; // positive integers, <= 200
  industryCodes?: string[]; // [A-Za-z0-9_-]{1,20}, <= 200
  enabled?: boolean; // true = only enabled, false = only not enabled; omit for both
  countryCode?: string; // ISO alpha-3: international variant, Newegg.com only (B2B/CA throw UnsupportedMarketplaceOperationError)
}
export interface SubcategoryStatus {
  industryCode?: string;
  industryName?: string;
  subcategoryId: number;
  subcategoryName?: string;
  enabled?: boolean; // undefined when Newegg sent none / an unparseable value
}
export interface SubcategoriesResult {
  marketplace: NeweggMarketplace;
  countryCode?: string;
  subcategories: SubcategoryStatus[]; // the full list can be thousands of rows
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface SubcategoryProperty {
  subcategoryId?: number;
  subcategoryName?: string;
  propertyName: string;
  isAdvancedSearch?: boolean;
  isGroupBy?: boolean;
  isRequired?: boolean;
}
export interface SubcategoryPropertiesResult {
  marketplace: NeweggMarketplace;
  subcategoryId: number;
  properties: SubcategoryProperty[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface ListPropertyValuesInput {
  propertyName: string; // 1-200 chars, no control characters
  subcategoryId: number; // required: live Newegg answers CE003 without it
}
export interface PropertyValues extends SubcategoryProperty {
  values: string[]; // one-value-per-row wire rows are merged and de-duplicated
}
export interface PropertyValuesResult {
  marketplace: NeweggMarketplace;
  properties: PropertyValues[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface ReferenceApi {
  getSellerStatus(options?: RequestOptions): Promise<SellerStatus>; // 500/hr
  listIndustries(input?: ListIndustriesInput, options?: RequestOptions): Promise<IndustriesResult>; // 10,000/hr
  listSubcategories(
    input?: ListSubcategoriesInput,
    options?: RequestOptions,
  ): Promise<SubcategoriesResult>; // 100/hr
  listSubcategoryProperties(
    subcategoryId: number,
    options?: RequestOptions,
  ): Promise<SubcategoryPropertiesResult>; // 100/hr
  listPropertyValues(
    input: ListPropertyValuesInput,
    options?: RequestOptions,
  ): Promise<PropertyValuesResult>; // 100/hr
}

// ----------------------------------------------------------------------------
// Shipped by Newegg (SBN) inbound-shipment reads (contracts §21; READ-only, none gated)
// ----------------------------------------------------------------------------
// Get Inbound Shipment List, Get Inbound Shipment Status Request, Get Inbound Shipment Request Result
// and Get Warehouse List. Three are PUT on the wire; all are reads. Newegg.com and Newegg Business
// only: on CAN every method throws UnsupportedMarketplaceOperationError before sending. Create / Void
// Inbound Shipment (writes) and Get Inbound Shipment Plan Suggestion (not shown to be side-effect
// free) are deliberately NOT implemented (contracts §21.1).
export type SbnShipmentKeywordType = "all" | "shipmentId" | "neweggItemNumber" | "sellerPartNumber";
export type SbnShipmentStatusFilter =
  "all" | "preparing" | "shipped" | "received" | "partiallyReceived" | "manuallyClosed" | "voided";
export type SbnRequestAction = "all" | "create" | "void";
export type SbnRequestStatusFilter = "ALL" | "SUBMITTED" | "IN_PROGRESS" | "FINISHED" | "CANCELLED";

export interface ListSbnShipmentsInput {
  page?: number; // 1-based, default 1
  pageSize?: number; // 1-100, default 100
  keywordType?: SbnShipmentKeywordType; // default "all"
  keyword?: string;
  status?: SbnShipmentStatusFilter; // default "all"
  updatedFrom?: Date | string; // Date -> Pacific wall-clock; both bounds empty = last 30 days
  updatedTo?: Date | string;
}
export interface SbnAddress {
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}
export interface SbnShipmentPackage {
  trackingNumber?: string;
  weight?: number;
  length?: number;
  height?: number;
  width?: number;
}
export interface SbnShipmentItem {
  sellerPartNumber?: string;
  quantity?: number;
  numberOfPackages?: number;
}
export interface SbnShipment {
  shipmentId: string;
  status?: string; // "Preparing" | "Ready to ship" | "Shipped" | "Received" | "Void" ... (as sent)
  createdAt?: { raw: string; iso?: string };
  lastEditedAt?: { raw: string; iso?: string };
  shipFrom?: string;
  shipToWarehouseCode?: string;
  shipTo: SbnAddress;
  shippingMethod?: "smallParcel" | "lessThanTruckload";
  carrierCode?: number; // 101 DHL, 102 FedEx, 103 UPS, 104 USPS, 105 Newegg UPS, 99 other
  carrier?: string;
  packages: SbnShipmentPackage[];
  items: SbnShipmentItem[];
}
export interface SbnShipmentsResult {
  marketplace: NeweggMarketplace;
  page: number; // echo of the request: the response has no total, a full page may have more
  pageSize: number;
  shipments: SbnShipment[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface GetSbnRequestStatusInput {
  requestIds?: string[]; // when set, Newegg ignores every other filter
  action?: SbnRequestAction; // default "all"
  maxCount?: number; // 1-100, default 100
  requestStatus?: SbnRequestStatusFilter; // default "ALL"
  requestDateFrom?: Date | string;
  requestDateTo?: Date | string;
}
export interface SbnRequestStatusEntry {
  requestId: string;
  action?: "create" | "void";
  requestedAt?: { raw: string; iso?: string };
  status?: string; // SUBMITTED | IN_PROGRESS | FINISHED | CANCELLED
  memo?: string;
}
export interface SbnRequestStatusResult {
  marketplace: NeweggMarketplace;
  requests: SbnRequestStatusEntry[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

// The label download URL is credential-bearing (like report file URLs): never exposed, only host + file name.
export interface SbnShipmentLabel {
  type?: string;
  host?: string;
  fileName?: string;
}
export interface SbnRequestResult {
  marketplace: NeweggMarketplace;
  requestId: string;
  requestedAt?: { raw: string; iso?: string };
  processedAt?: { raw: string; iso?: string };
  status?: string;
  shipmentId?: string;
  labels: SbnShipmentLabel[];
  errors: string[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown; // sanitized: credential-bearing URLs redacted
}

export interface ListSbnWarehousesInput {
  warehouseCode?: string;
} // 1-3 digits; omit = all (ASSUMPTION)
export interface SbnWarehouse {
  warehouseCode: string;
  allowBulkItem?: boolean;
  allowSmallItem?: boolean;
  address: SbnAddress;
}
export interface SbnWarehousesResult {
  marketplace: NeweggMarketplace;
  warehouses: SbnWarehouse[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export interface SbnApi {
  listShipments(
    input?: ListSbnShipmentsInput,
    options?: RequestOptions,
  ): Promise<SbnShipmentsResult>; // 500/hr
  getRequestStatus(
    input?: GetSbnRequestStatusInput,
    options?: RequestOptions,
  ): Promise<SbnRequestStatusResult>; // 1,000/min
  getRequestResult(requestId: string, options?: RequestOptions): Promise<SbnRequestResult>; // 500/hr
  listWarehouses(
    input?: ListSbnWarehousesInput,
    options?: RequestOptions,
  ): Promise<SbnWarehousesResult>; // 1,000/min
}

// ----------------------------------------------------------------------------
// Sponsored Ads reads (contracts §25)
// ----------------------------------------------------------------------------
/** Paging and sorting shared by every Sponsored Ads list/report input. */
export interface AdsPagingInput {
  /** 1-based page (default 1, at most 10,000: an SDK sanity bound, not a documented Newegg limit). */
  page?: number;
  /** Rows per page (default 100; the maximum is 100 for campaigns/groups, 9,999,999 elsewhere). */
  pageSize?: number;
  /** Field to sort by (Newegg's default is `InDate`). */
  sortField?: string;
  /** Sort direction (Newegg's default is descending). */
  sortOrder?: "asc" | "desc";
}

/** `Active` = Processing, Delivering or Out of budget; `Inactive` = Inactive or Ended. */
export type AdsActiveStatusFilter = "active" | "inactive";

/** Whether a name filter matches by text (fuzzy) or by identifier number (exact). */
export type AdsSearchBy = "name" | "number";

export interface ListAdsCampaignsInput extends AdsPagingInput {
  /** Value matched against `searchBy` (a campaign name, or a campaign number). */
  keyword?: string;
  /** What `keyword` matches (default `"name"`). */
  searchBy?: AdsSearchBy;
  /** Campaign type: 0 manual targeting, 1 auto targeting. */
  type?: number;
  /** 0 Sponsored Products, 1 Sponsored Headlines, 2 Sponsored Video, 3 Sponsored Display, 4 Offsite Ads. */
  sponsorType?: number;
  /** With `sponsorType` 3: 2 on-site, 3 off-site product targeting. */
  displayType?: number;
  activeStatus?: AdsActiveStatusFilter;
  /** ISO 3-letter country code, e.g. `"USA"`. */
  countryCode?: string;
  /** Campaign start filter, `YYYY-MM-DD` (a `Date` is rendered in Pacific time). */
  fromDate?: Date | string;
  /** Campaign end filter, `YYYY-MM-DD`. */
  toDate?: Date | string;
}

export interface ListAdsGroupsInput extends AdsPagingInput {
  campaignNumber: number;
  /** Value matched against `searchBy` (a group name, or comma-separated group numbers). */
  keyword?: string;
  /** What `keyword` matches (default `"name"`). */
  searchBy?: AdsSearchBy;
  activeStatus?: AdsActiveStatusFilter;
  countryCode?: string;
  fromDate?: Date | string;
  toDate?: Date | string;
}

export interface ListAdsProductsInput extends AdsPagingInput {
  campaignNumber: number;
  groupNumber: number;
  keyword?: string;
  searchBy?: AdsSearchBy;
  activeStatus?: AdsActiveStatusFilter;
  /** ISO 3-letter country code (default `"USA"`). */
  countryCode?: string;
}

export interface ListAdsKeywordsInput extends AdsPagingInput {
  campaignNumber: number;
  groupNumber?: number;
  /** Fuzzy-matched keyword text. */
  keyword?: string;
  activeStatus?: AdsActiveStatusFilter;
}

export interface ListAdsNegativeKeywordsInput extends AdsPagingInput {
  campaignNumber: number;
  groupNumber: number;
  /** Value matched against `searchBy` (keyword text, or a negative keyword number). */
  keyword?: string;
  searchBy?: AdsSearchBy;
  /** Only active (`true`) or only deactivated (`false`) negative keywords. */
  active?: boolean;
}

export interface SuggestAdsKeywordsInput {
  /** Newegg item numbers (1-50) to get keyword and bid recommendations for. */
  itemNumbers: string[];
  /** Optional keyword texts to price as well. */
  keywords?: string[];
  /** 0 Sponsored Products (default), 1 Sponsored Headlines, 2 Sponsored Video. */
  sponsorType?: number;
  /** `"manual"` (default) or `"auto"` targeting. */
  targeting?: "manual" | "auto";
  /** `"cpm"` or `"cpc"`. */
  costModel?: "cpm" | "cpc";
}

export interface ListAdsMatchTypesInput {
  campaignNumber: number;
  groupNumber: number;
}

/** Which surface a product-targeting suggestion is for (`productType` 1-3). */
export type AdsTargetingProductType = "productTargeting" | "displayOnSite" | "displayOffSite";

export interface SuggestAdsCategoryTargetingInput {
  /** Newegg category numbers (1-50). */
  categoryCodes: string[];
  productType: AdsTargetingProductType;
  /** `"recommend"` (0) or `"search"` (1); default `"recommend"`. */
  mode?: "recommend" | "search";
  countryCode?: string;
}

export interface SuggestAdsItemTargetingInput {
  /** Newegg item numbers (1-50). */
  itemNumbers: string[];
  productType: AdsTargetingProductType;
  mode?: "recommend" | "search";
  countryCode?: string;
}

/** Performance report over a date range. `fromDate` and `toDate` are required (`YYYY-MM-DD`). */
export interface AdsPerformanceRange {
  fromDate: Date | string;
  toDate: Date | string;
}

export interface GetAdsGroupPerformanceInput extends AdsPagingInput, AdsPerformanceRange {
  /** Restrict to one campaign. */
  campaignNumber?: number;
  /** Campaign type: 0 manual, 1 auto. */
  type?: number;
  sponsorType?: number;
  keyword?: string;
  searchBy?: AdsSearchBy;
  activeStatus?: AdsActiveStatusFilter;
  countryCode?: string;
}

export interface GetAdsProductPerformanceInput extends AdsPagingInput, AdsPerformanceRange {
  campaignNumber: number;
  groupNumber: number;
  keyword?: string;
  searchBy?: AdsSearchBy;
  activeStatus?: AdsActiveStatusFilter;
  countryCode?: string;
}

export interface GetAdsKeywordPerformanceInput extends AdsPagingInput, AdsPerformanceRange {
  campaignNumber: number;
  groupNumber: number;
  keyword?: string;
  activeStatus?: AdsActiveStatusFilter;
  countryCode?: string;
}

/** Bid recommendation triple Newegg attaches to keywords, groups and match types. */
export interface AdsSuggestedBid {
  suggBid?: number;
  suggBidLowest?: number;
  suggBidMost?: number;
}

/** Advertising metrics of a performance row. `acos` = spend / sales. */
export interface AdsMetrics {
  spend?: number;
  sales?: number;
  acos?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  orders?: number;
  /** Conversion rate. */
  cr?: number;
  cpc?: number;
}

export interface AdsCampaign {
  campaignNumber: number;
  name?: string;
  countryCode?: string;
  /** 0 manual, 1 auto, 2/3 headlines manual/auto, 4/5 video manual/auto, 6 sponsored display. */
  type?: number;
  /** `Active` or `Inactive`. */
  activeStatus?: string;
  /** Pending, Delivering, Processing, Out of budget, Inactive or Ended. */
  status?: string;
  startDate?: string;
  endDate?: string;
  budget?: number;
  dailyBudget?: number;
  groupCount?: number;
  /** Pacific-time text as Newegg sent it, e.g. `Wed May 04 03:57:04 PDT 2022`. */
  createdAt?: string;
  lastEditedAt?: string;
  displayType?: string;
  declineReason?: string;
  /** 0 CPM, 1 CPC. */
  costModel?: number;
}

export interface AdsGroup extends AdsSuggestedBid {
  campaignNumber?: number;
  campaignName?: string;
  groupNumber: number;
  groupName?: string;
  countryCode?: string;
  defaultBid?: number;
  offSiteBid?: number;
  /** 0 keyword, 1 product targeting, 2 on-site product, 3 off-site product targeting. */
  type?: number;
  keywordCount?: number;
  productCount?: number;
  /** Newegg item numbers in the group. */
  productItemNumbers: string[];
  activeStatus?: string;
  status?: string;
  createdAt?: string;
  landingPageType?: number;
  landingPageUrl?: string;
  declineReason?: string;
  /** 0 CPM, 1 CPC. */
  costModel?: number;
}

export interface AdsGroupPerformance extends AdsGroup, AdsMetrics {}

export interface AdsProduct {
  campaignNumber?: number;
  campaignName?: string;
  groupNumber?: number;
  groupName?: string;
  itemNumber: string;
  itemTitle?: string;
  countryCode?: string;
  sellingPrice?: number;
  sellerPartNumber?: string;
  itemStatus?: string;
  activeStatus?: string;
  status?: string;
  declineReason?: string;
}

export interface AdsProductPerformance extends AdsProduct, AdsMetrics {
  createdAt?: string;
}

export interface AdsKeyword extends AdsSuggestedBid {
  campaignNumber?: number;
  campaignName?: string;
  groupNumber?: number;
  groupName?: string;
  keyword: string;
  /** 0 exact, 1 broad, 6 phrase. */
  matchType?: number;
  normalizedKeyword?: string;
  keywordUrl?: string;
  searchVolume?: string;
  /** Low, Medium or High. */
  competition?: string;
  bid?: number;
  activeStatus?: string;
  status?: string;
  declineReason?: string;
}

export interface AdsKeywordPerformance extends AdsKeyword, AdsMetrics {
  createdAt?: string;
}

export interface AdsNegativeKeyword {
  /** Identifier of the negative keyword. */
  transactionNumber?: number;
  keyword: string;
  formatKeyword?: string;
  /** 0 exact match, 6 phrase match. */
  keywordType?: number;
  /** 0 deactivated, 1 active. */
  status?: number;
}

/** Bid of an auto-targeting match type (2 close, 3 loose, 4 substitutes, 5 complements). */
export interface AdsMatchType extends AdsSuggestedBid {
  matchType: number;
  matchTypeName?: string;
  bid?: number;
  activeStatus?: string;
  status?: string;
  declineReason?: string;
}

export interface AdsKeywordSuggestion extends AdsSuggestedBid {
  keyword: string;
  normalizedKeyword?: string;
  /** The seller's item numbers the keyword was suggested for. */
  itemNumbers: string[];
  keywordUrl?: string;
  /** 0 exact, 1 broad, 6 phrase. */
  matchType?: number;
  searchVolume?: string;
  competition?: string;
  bid?: number;
}

export interface AdsCategoryTargeting {
  categoryCode: string;
  priceSuggestBid?: number;
  priceLowerBound?: number;
  priceHigherBound?: number;
  lastEditedAt?: string;
}

export interface AdsItemTargeting {
  itemNumber: string;
  relatedPrimaryItem?: string;
  priceSuggestBid?: number;
  priceLowerBound?: number;
  priceHigherBound?: number;
}

/** A page of Sponsored Ads rows. Every Sponsored Ads read returns this shape. */
export interface AdsPage<T> {
  marketplace: NeweggMarketplace;
  rows: T[];
  /** `totalRows` as sent (the count across all pages), else the rows on this page. */
  totalRows: number;
  /** Echo of the requested paging (absent for the unpaged suggestion reads). */
  page?: number;
  pageSize?: number;
  /** Newegg's `header[0].msg`, e.g. `search campaigns success`. */
  message?: string;
  /** Newegg's `header[0].bizCode`, e.g. `025`. */
  bizCode?: string;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Result of {@link AdsApi.suggestKeywords}: the page plus the group-level suggestions. */
export interface AdsKeywordSuggestionsResult extends AdsPage<AdsKeywordSuggestion> {
  suggestedBid: AdsSuggestedBid;
  /** Suggested bids of the auto-targeting match types (2 close ... 5 complements). */
  matchTypes: AdsMatchType[];
}

/**
 * Sponsored Ads reads (contracts §25). Newegg.com and Newegg.ca: on Newegg Business every method
 * throws {@link UnsupportedMarketplaceOperationError} before sending. Every method is a READ (each
 * endpoint is a `POST` search or synchronous report). Creating, changing and activating campaigns,
 * ad groups, products, keywords, negative keywords and targeting spends money and is intentionally
 * not implemented.
 */
export interface AdsApi {
  /** Campaign List / Campaign Performance Report (1,000 req/hr). */
  listCampaigns(
    input?: ListAdsCampaignsInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsCampaign>>;
  /** Group List. */
  listGroups(input: ListAdsGroupsInput, options?: RequestOptions): Promise<AdsPage<AdsGroup>>;
  /** Product List: the items in one ad group. */
  listProducts(input: ListAdsProductsInput, options?: RequestOptions): Promise<AdsPage<AdsProduct>>;
  /** Keywords List. */
  listKeywords(input: ListAdsKeywordsInput, options?: RequestOptions): Promise<AdsPage<AdsKeyword>>;
  /** Negative Keyword List. */
  listNegativeKeywords(
    input: ListAdsNegativeKeywordsInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsNegativeKeyword>>;
  /** Auto Targeting Match Type List: the bid of each match type of an auto-targeting group. */
  listMatchTypes(
    input: ListAdsMatchTypesInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsMatchType>>;
  /** Keywords Suggest: recommended keywords and bids for items. Creates nothing. */
  suggestKeywords(
    input: SuggestAdsKeywordsInput,
    options?: RequestOptions,
  ): Promise<AdsKeywordSuggestionsResult>;
  /** Product Targeting Categories: recommended bids per category. Creates nothing. */
  suggestCategoryTargeting(
    input: SuggestAdsCategoryTargetingInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsCategoryTargeting>>;
  /** Product Targeting Individual: recommended bids per item. Creates nothing. */
  suggestItemTargeting(
    input: SuggestAdsItemTargetingInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsItemTargeting>>;
  /** Group Performance Report (synchronous; spend, sales, ACoS, clicks per ad group). */
  getGroupPerformance(
    input: GetAdsGroupPerformanceInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsGroupPerformance>>;
  /** Product Performance Report (synchronous). */
  getProductPerformance(
    input: GetAdsProductPerformanceInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsProductPerformance>>;
  /** Keywords Performance Report (synchronous). */
  getKeywordPerformance(
    input: GetAdsKeywordPerformanceInput,
    options?: RequestOptions,
  ): Promise<AdsPage<AdsKeywordPerformance>>;
}

// ----------------------------------------------------------------------------
// listings (existing item creation — contracts §13; WRITE surface)
// ----------------------------------------------------------------------------
// create() submits an ITEM_DATA data feed with the bare `&v2` template flag (BatchItemCreation).
// It adds seller offers on products ALREADY in Newegg's catalog — resolve identifiers with
// catalog.resolve() first. previewCreate() is offline (validation + envelopes, zero network).
export type ListingCondition = "New" | "Refurbished";
export type ListingShipping = "Default" | "Free";

export interface CreateListingInput {
  sellerPartNumber: string; // seller SKU, <=40 chars, immutable once created
  manufacturer: string; // always required; must match Newegg's predefined manufacturer name
  neweggItemNumber?: string;
  upc?: string;
  manufacturerPartNumber?: string; // wire field ManufacturerPartsNumber
  sellingPrice: number;
  quantity: number; // available quantity for the default warehouse
  condition?: ListingCondition; // default "New"; immutable once created
  packsOrSets?: number; // default 1; immutable once created
  shipping?: ListingShipping; // default "Default"
  activate?: boolean; // default false: offer created DEACTIVATED (hidden, not for sale)
  currency?: "USD" | "CAD";
  msrp?: number;
  map?: number;
  checkoutMap?: boolean;
  countryOfOrigin?: string; // ISO 3166-1 alpha-3
  leadTime?: number; // business days, 1-14; Newegg defaults to 2 when omitted
  shippingTemplate?: string;
}

export interface NormalizedCreateListing extends CreateListingInput {
  inputIndex: number;
  condition: ListingCondition;
  packsOrSets: number;
  shipping: ListingShipping;
  activate: boolean;
}

export interface ListingCreatePreview {
  marketplace: NeweggMarketplace;
  items: NormalizedCreateListing[];
  itemCount: number;
  chunkCount: number;
  warnings: string[];
  envelopes: unknown[]; // one §13.2 envelope per chunk — exactly what create() would submit
}

// Accepts raw inputs OR the normalized output of a prior previewCreate (round-trip safe —
// inputIndex is stripped internally, so preview.items can be fed straight back in).
export type CreateListingInputOrNormalized = CreateListingInput | NormalizedCreateListing;

export interface ListingsApi {
  // Validate + normalize + build envelopes without any network access.
  previewCreate(
    input: CreateListingInputOrNormalized | CreateListingInputOrNormalized[],
  ): ListingCreatePreview;
  // WRITE: submit the Existing Item Creation feed (chunked at 3000). Poll the returned
  // requestId(s) with feeds.getStatus / feeds.getResult. Returns FeedSubmission.
  create(
    input: CreateListingInputOrNormalized | CreateListingInputOrNormalized[],
    options?: RequestOptions,
  ): Promise<FeedSubmission>;
}

// ----------------------------------------------------------------------------
// volumeDiscounts (quantity-tier pricing — contracts §22)
// ----------------------------------------------------------------------------
// get/tryGet are READS (Get Volume Discount is a PUT on the wire; works on all three platforms).
// update() submits a VOLUME_DISCOUNT_DATA data feed (the direct Submit Volume Discount endpoint is
// unusable on Newegg.ca, §22.2) and is enabled for the Canadian marketplace only; other
// marketplaces throw UnsupportedMarketplaceOperationError from previewUpdate/update.
// An update REPLACES the item's whole discount. previewUpdate() is offline (zero network).
export interface GetVolumeDiscountInput {
  neweggItemNumber?: string; // wins when both are given
  sellerPartNumber?: string;
}

export interface VolumeDiscountTierSnapshot {
  priority: number; // 1-based
  quantity: number;
  sellingPrice: number;
  freeShipping: boolean; // EnableFreeShipping 1
}

export interface VolumeDiscountSnapshot {
  marketplace: NeweggMarketplace;
  neweggItemNumber?: string;
  sellerPartNumber?: string;
  tiers: VolumeDiscountTierSnapshot[]; // ordered by priority
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown; // only with includeRaw, sanitized
}

export interface VolumeDiscountTier {
  quantity: number; // integer >= 2, strictly above the previous tier's
  sellingPrice: number; // > 0, strictly below the previous tier's (cent-rounded)
  freeShipping?: boolean; // default false
}

export interface VolumeDiscountUpdate {
  neweggItemNumber?: string; // at least one identifier is required
  sellerPartNumber?: string;
  tiers: VolumeDiscountTier[]; // 1-3, tier 1 first
}

export interface NormalizedVolumeDiscountTier {
  priority: number;
  quantity: number;
  sellingPrice: number;
  freeShipping: boolean;
}

export interface NormalizedVolumeDiscountUpdate {
  inputIndex: number;
  neweggItemNumber?: string;
  sellerPartNumber?: string;
  tiers: NormalizedVolumeDiscountTier[];
}

export interface VolumeDiscountUpdatePreview {
  marketplace: NeweggMarketplace;
  items: NormalizedVolumeDiscountUpdate[];
  itemCount: number;
  chunkCount: number;
  warnings: string[];
  envelopes: unknown[]; // one §22.3 envelope per chunk — exactly what update() would submit
}

// Accepts raw inputs OR the normalized output of a prior previewUpdate (round-trip safe).
export type VolumeDiscountUpdateOrNormalized =
  VolumeDiscountUpdate | NormalizedVolumeDiscountUpdate;

export interface VolumeDiscountsApi {
  get(input: GetVolumeDiscountInput, options?: RequestOptions): Promise<VolumeDiscountSnapshot>; // CT060 => NeweggApiError
  tryGet(
    input: GetVolumeDiscountInput,
    options?: RequestOptions,
  ): Promise<VolumeDiscountSnapshot | undefined>; // undefined only for CT060 (no discount yet)
  previewUpdate(
    input: VolumeDiscountUpdateOrNormalized | VolumeDiscountUpdateOrNormalized[],
  ): VolumeDiscountUpdatePreview;
  // WRITE: submit the VOLUME_DISCOUNT_DATA feed (chunked at 10,000). Poll the returned requestId(s)
  // with feeds.getStatus / feeds.getResult; the discount is readable ~13 minutes after FINISHED.
  update(
    input: VolumeDiscountUpdateOrNormalized | VolumeDiscountUpdateOrNormalized[],
    options?: RequestOptions,
  ): Promise<FeedSubmission>;
}

// ----------------------------------------------------------------------------
// storefront (public buy-box / offers — contracts §14) — UNOFFICIAL, read-only
//
// The PUBLIC retail storefront, not the seller API: unauthenticated, undocumented, no SLA,
// may change without notice. Sends no credentials and mutates nothing. Exists because the
// seller API has no competitive-pricing surface at all.
// ----------------------------------------------------------------------------
export interface StorefrontRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number; // defaults to the client's timeoutMs
}

export interface StorefrontOffer {
  // Newegg first-party offers echo the PARENT catalog number; marketplace offers the 9SI… offer number.
  readonly offerItemNumber: string;
  readonly sellerName: string | undefined; // undefined for Newegg first-party
  readonly sellerId: string | undefined; // undefined for Newegg first-party
  readonly isNewegg: boolean; // Seller null/empty ⇒ true
  readonly price: number; // UnitCost
  // Raw ShippingCharge. CAUTION: 0.01 is observed on "Free Shipping" offers — a non-zero
  // value does NOT reliably mean paid shipping (contracts §14.1).
  readonly shippingCharge: number;
  readonly inStock: boolean;
  readonly active: boolean;
}

export interface StorefrontOffersResult {
  readonly parentItemNumber: string; // the parent actually queried (post-normalization)
  readonly offers: readonly StorefrontOffer[]; // storefront order, preserved
  // ASSUMPTION: first offer = buy box (storefront ordering looks like its featured ranking
  // and matched the page's buy box in every observation). undefined when there are no offers.
  readonly buyBox: StorefrontOffer | undefined;
  readonly total: number; // envelope Total, falling back to offers.length
}

// itemNumber: dashed catalog form ("20-156-294"), product-page form ("N82E16820156294",
// normalized to dashed), or a marketplace parent CODE ("3C6-00T1-002H0").
// offerNumber: a 9SI… seller offer number — costs one extra request (the SDK resolves it to
// its parent via the product page's 301 Location first, contracts §14.2).
export type GetOffersArgs = { itemNumber: string } | { offerNumber: string };

export interface StorefrontApi {
  // Throws NeweggApiError on non-2xx, an unparsable body, or an unresolvable offer number;
  // UnsupportedMarketplaceOperationError on "b2b"; NeweggValidationError on an empty identifier.
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
export class InMemoryRateLimitStore implements RateLimitStore {
  /* provided */
}

// ----------------------------------------------------------------------------
// retry / idempotency
// ----------------------------------------------------------------------------
export interface RetryOptions {
  maxAttempts?: number; // default 3 (initial + 2 retries)
  baseDelayMs?: number; // default 250, full-jitter exponential
  maxDelayMs?: number; // default 10_000
}
export interface StoredOperation {
  state: "submitting" | "submitted" | "failed";
  payloadHash: string;
  requestIds?: string[];
  updatedAt: string; // ISO
}
export interface OperationStore {
  get(key: string): Promise<StoredOperation | undefined>;
  put(key: string, op: StoredOperation): Promise<void>;
  /** Optional compare-and-set: writes op and resolves true only while the record is still expected (undefined = none). The label-create ledger uses it so two processes sharing a store cannot both claim an order. */
  compareAndPut?(
    key: string,
    expected: StoredOperation | undefined,
    op: StoredOperation,
  ): Promise<boolean>;
}
export class InMemoryOperationStore implements OperationStore {
  /* provided */
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
/** Structured events: request_started, request_completed, retry_scheduled, rate_limit_wait,
 * feed_submitted, feed_status_changed, feed_processing_completed, partial_failure,
 * indeterminate_submission. Fields always include correlationId, operation, marketplace,
 * sellerIdHash (keyed HMAC token, stable per process only, never the raw seller ID), durationMs where relevant.
 * Authorization/SecretKey/api key/secret values are never logged. */

// ----------------------------------------------------------------------------
// errors (all extend NeweggError; every one carries the fields below)
// ----------------------------------------------------------------------------
export type NeweggErrorCode =
  | "configuration"
  | "validation"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "api"
  | "feed_submission"
  | "feed_submission_indeterminate"
  | "feed_processing"
  | "feed_cancelled"
  | "timeout"
  | "unsupported_operation";

export class NeweggError extends Error {
  readonly code: NeweggErrorCode;
  readonly httpStatus?: number;
  readonly neweggErrorCode?: string; // e.g. CT002, DF012, InvalidToken
  readonly neweggRequestId?: string; // feed request id when relevant
  readonly correlationId?: string;
  readonly retryable: boolean;
  readonly details?: unknown; // sanitized, JSON-safe; credential values masked like `message` (below)
  // `message` and every string in `details` are redacted like a cause string (URL credentials, then the value of a
  // credential name: sellerid=, token=, Authorization: Bearer ..., "SecretKey":"...", Cookie / Set-Cookie lines,
  // percent-encoded spellings included); a string kept under a credential key in `details` (SecretKey, token, ...) is
  // masked as well. A bare `name: value` (colon only) counts for multi-word names (SellerID, SecretKey, Access-Token,
  // client_secret, X-Api-Key, ...) and Authorization; for the single generic words (token, password, passwd, secret) a
  // colon is prose and is left alone (`Unexpected token: }`, and also `Password: hunter2`, a documented limit), while
  // `=`, a quoted name, a quoted value (`{ token: 'x' }`) and an object-literal key with a number / boolean value
  // (`{ password: 12345 }`) are masked.
  // `cause` (standard Error.cause) is sanitized too: URL credentials are removed from the cause's message, stack,
  // string properties and nested causes, so util.inspect / console.log of the error cannot print them. The value of
  // a credential name (sellerid, token, secret, password, api-key, Authorization incl. "Bearer ...", SecretKey, ...,
  // Cookie / Set-Cookie lines, also percent-encoded) is masked in strings, in URLSearchParams entries, in string-valued own properties with such
  // a name, and in Headers / Request / Response headers. Functions (own properties), URLSearchParams (names and
  // values) and Headers are rebuilt from redacted entries, own properties included (string-keyed only: a secret
  // stored under a SYMBOL key on these four types is not redacted, low risk, documented). A Response or Request
  // becomes a redacted util.inspect text only when redaction changes something (its text, a credential header or an
  // own property); otherwise the original is kept. The same text form replaces any object whose copy would not work
  // (#private fields). A caller's getters and inspect/toJSON hooks are never run. Out of contract: secrets that only
  // a toJSON / custom inspect, a Proxy, a Promise or FormData reveal, and credentials in property keys.
}
// Replaces the user:password@ part of any URL in `text` with ***@ - percent-encoded, schemeless on a Newegg FTP
// host, scheme-relative, backslash, triple-slash and JSON-escaped forms included. Linear time. Never throws.
// There is no limit on userinfo or password length (the reserved-character-password pass still bounds the Newegg
// host to labels of at most 63 characters, at most 9 labels, in a 600-character window). Known limits: a password
// containing whitespace and a schemeless credential on a host other than a Newegg FTP report host.
export function redactUrlCredentials(text: string): string;
export class NeweggConfigurationError extends NeweggError {}
// Thrown by createNeweggClient when credentialMarketplace differs from marketplace (expectedMarketplace =
// the client's marketplace, actualMarketplace = the credentials'), and by the orders currency guard when a
// whole page of orders is in the wrong marketplace's currency (actualMarketplace inferred, or undefined).
// code === "configuration"; messages and toJSON carry marketplace names only, never credential values.
// Thrown by createNeweggClient ONLY when baseUrl is outside the newegg.com allowlist and allowCustomBaseUrl is not
// set (T-6217). A missing trailing "/", an invalid URL and non-loopback http stay plain NeweggConfigurationErrors.
// code === "configuration"; the message is static and never includes the URL or host.
export class NeweggBaseUrlNotAllowedError extends NeweggConfigurationError {}
export class NeweggMarketplaceMismatchError extends NeweggConfigurationError {
  readonly expectedMarketplace: NeweggMarketplace;
  readonly actualMarketplace?: NeweggMarketplace;
}
export class NeweggValidationError extends NeweggError {
  readonly issues: Array<{ path: string; message: string; inputIndex?: number }>;
}
export class NeweggAuthenticationError extends NeweggError {}
export class NeweggAuthorizationError extends NeweggError {}
export class NeweggRateLimitError extends NeweggError {
  readonly rateLimit?: RateLimitInfo;
  readonly retryAfterMs?: number;
}
export class NeweggApiError extends NeweggError {}
export class NeweggFeedSubmissionError extends NeweggError {}
export class IndeterminateFeedSubmissionError extends NeweggError {
  readonly payloadHash: string;
  readonly marketplace: NeweggMarketplace;
  readonly submittedAtIso: string;
  readonly guidance: string; // "check recent feed status before resubmitting…"
}
export class IndeterminateOrderWriteError extends NeweggError {
  readonly marketplace: NeweggMarketplace;
  readonly operation: string; // e.g. "orders.ship"
  readonly submittedAtIso: string;
  readonly orderNumber?: string;
  readonly guidance: string; // "check order status (orders.getStatus) before retrying…"
}
export class IndeterminateServiceWriteError extends NeweggError {
  // code "service_write_indeterminate"; retryable is always false
  readonly marketplace: NeweggMarketplace;
  readonly operation: ServiceWriteOperation; // e.g. "rma.submit", "refunds.issue"
  readonly submittedAtIso: string;
  readonly orderNumber?: string;
  readonly rmaNumber?: string;
  readonly guidance: string; // "check rma.list/get or refunds.list/listRequests before retrying…"
}
export class NeweggFeedProcessingError extends NeweggError {}
export class NeweggFeedCancelledError extends NeweggError {}
export class NeweggTimeoutError extends NeweggError {}
export class UnsupportedMarketplaceOperationError extends NeweggError {}

// ----------------------------------------------------------------------------
// testing utilities (exported from "@devino/newegg-marketplace-sdk/testing")
// ----------------------------------------------------------------------------
export function createMockFetch(routes: MockRoute[]): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
};
export interface MockReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export interface MockRoute {
  method: string;
  pathPattern: RegExp | string;
  reply: (req: RecordedCall) => MockReply | Promise<MockReply>;
}
export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  bodyText?: string;
  bodyJson?: unknown;
}

// ----------------------------------------------------------------------------
// Shipping Label Service (contracts §23): estimate is a quote sent ONCE, never retried; create BUYS a UPS label (WRITE);
// reprint re-issues a label (WRITE, billing unknown). Not gated by marketplace: the service codes
// differ (101-105 on us/b2b, 111-114 on ca; platform/shipping-label.ts).
// ----------------------------------------------------------------------------
export interface ShippingLabelShipFrom {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  address1: string;
  address2?: string;
  city: string;
  stateCode: string; // two letters, uppercased
  zipCode: string; // US ZIP (us/b2b) or Canadian postal code (ca)
  countryCode?: string; // "USA" | "CAN"; defaults to the marketplace's
}
export interface ShippingLabelItem {
  sellerPartNumber: string;
  quantity: number; // a line's whole ordered quantity must ship (SL005)
}
export interface ShippingLabelPackage {
  weightLb: number; // UPS max 150
  lengthIn: number; // UPS max 108
  widthIn: number;
  heightIn: number; // length + 2 x width + 2 x height <= 165
  signatureRequired?: boolean; // adds a surcharge
  items: ShippingLabelItem[];
}
export interface ShippingLabelInput {
  orderNumber: string | number; // 1..2147483647
  serviceCode?: number; // 101-105 (us/b2b), 111-114 (ca); omitted = the service the customer bought
  shipFrom: ShippingLabelShipFrom;
  packages: ShippingLabelPackage[]; // 1..20 (SDK ceiling)
}
export interface ShippingLabelReprintInput {
  orderNumber: string;
}
export type ShippingLabelWriteOperation = "shippingLabels.create" | "shippingLabels.reprint";
// An earlier create for the same order that blocks a new one (T-6212; recorded in the client's
// OperationStore under label-create:<marketplace>:<order>, 24 h).
export interface LabelCreateAttempt {
  state: "submitting" | "submitted"; // submitting = dispatched, outcome unknown; submitted = bought
  attemptId: string; // what acknowledgePriorAttemptId names; NOT secret from the code that receives it
  atIso: string;
}
export interface ShippingLabelCreateOptions extends RequestOptions {
  // Clears ONLY that attempt, and not while the order lists a package. NOT a human gate: any code that holds
  // the id (it is in LabelCreateGuardError.attempt and ShippingLabelPreview.priorAttempt) can pass it. A caller
  // that needs a human decision must keep the id from the automated actor, as the MCP does (it never offers this).
  acknowledgePriorAttemptId?: string;
  // Replaces the default remedy text of the blocker/error (which names acknowledgePriorAttemptId) and leaves the id out.
  priorAttemptGuidance?: string;
}
export interface ShippingLabelPreview<N> {
  marketplace: NeweggMarketplace;
  operation: ShippingLabelWriteOperation;
  normalized: N; // round-trips straight into create / reprint
  currency: RmaCurrency; // assumed from the marketplace
  orderNumber: string;
  blockers: string[]; // non-empty => the write throws NeweggValidationError
  warnings: string[];
  correlationId: string;
  priorAttempt?: LabelCreateAttempt; // previewCreate only: the earlier create that blocks (or was acknowledged for) this one
}
export interface ShippingLabelRate {
  shipWeight?: number;
  arriveBy?: { raw: string; iso?: string };
  shippingAmount?: number;
  signatureAmount?: number;
  total?: number;
}
export interface ShippingLabelEstimatePackage {
  succeeded: boolean;
  errorMessage?: string;
  weightLb?: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  signatureRequired: boolean;
  rate?: ShippingLabelRate;
}
export interface ShippingLabelEstimate {
  marketplace: NeweggMarketplace;
  orderNumber: string;
  estimatedDate?: { raw: string; iso?: string };
  currency: RmaCurrency;
  packages: ShippingLabelEstimatePackage[];
  estimatedTotal: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface ShippingLabelPackageResult {
  succeeded: boolean;
  errorMessage?: string;
  trackingNumber?: string;
  signatureRequired: boolean;
  labelUrl?: string; // bearer download link: sensitive
  packingListUrl?: string; // Newegg spells it PackageListUrl and PackingListUrl
  rate?: ShippingLabelRate;
  items: ShippingLabelItem[];
}
export interface ShippingLabelResult {
  marketplace: NeweggMarketplace;
  operation: "shippingLabels.create";
  orderNumber: string;
  shipDate?: { raw: string; iso?: string };
  currency: RmaCurrency;
  packages: ShippingLabelPackageResult[];
  succeededCount: number; // >= 1 (all-failed throws NeweggApiError)
  failedCount: number;
  totalCharged: number;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface ShippingLabelReprintResult {
  marketplace: NeweggMarketplace;
  operation: "shippingLabels.reprint";
  orderNumber: string;
  orderStatus?: string;
  packages: ShippingLabelPackageResult[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}
export interface ShippingLabelsApi {
  estimate(input: ShippingLabelInput, options?: RequestOptions): Promise<ShippingLabelEstimate>; // 1,000/hr; single attempt (no retry)
  previewCreate(
    input: ShippingLabelInput,
    options?: ShippingLabelCreateOptions,
  ): Promise<ShippingLabelPreview<ShippingLabelInput>>; // reads the order; a prior attempt becomes a blocker + priorAttempt
  assertCreateNotBlocked(
    orderNumber: string | number,
    options?: Pick<ShippingLabelCreateOptions, "priorAttemptGuidance">,
  ): Promise<void>; // ledger only, NO Newegg request; throws LabelCreateGuardError
  create(
    input: ShippingLabelInput,
    options?: ShippingLabelCreateOptions,
  ): Promise<ShippingLabelResult>; // WRITE, 1,000/hr; throws LabelCreateGuardError (nothing sent) after an indeterminate or successful create of the same order
  previewReprint(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<ShippingLabelPreview<ShippingLabelReprintInput>>;
  reprint(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<ShippingLabelReprintResult>; // WRITE (billing unknown), 1,000/hr
}
```

## Behavioural requirements bound to this surface

1. **Validation**: all public inputs validated with Zod v4 `.strict()` schemas — unknown
   keys rejected; quantity: non-negative safe integer (0 valid); US ops require
   `warehouseLocation` matching `/^[A-Z]{3}$/`; seller part number: non-empty, ≤ 40 chars;
   `upc.condition` serialized only for UPC identifiers.
2. **Strategy "auto"**: post-dedup count ≤ `autoFeedThreshold` (default 8) → direct;
   otherwise feed. Feed requires `sellerPartNumber` identifiers: with strategy `auto`,
   items lacking one fall back to direct; with explicit `feed`, throw
   `NeweggValidationError` listing offending `inputIndex`es. Nothing is silently dropped.
3. **Dedup**: last-write-wins on `(marketplace, identifier type+value, warehouseLocation ?? "")`,
   reported via `deduplicated` / `deduplicatedItemCount`.
4. **Feed lifecycle**: submission acceptance ≠ item success. `waitForResult` uses bounded
   exponential polling, honors `signal`, returns (not throws) `timeout` outcome.
5. **Retry**: direct reads/writes retry on network errors, 408, 429, 502/503/504 with
   full-jitter backoff honoring `X-RateLimit-ResetTime`/`retryAfterMs`. Feed submission
   NEVER auto-retries after the body may have reached Newegg — throw
   `IndeterminateFeedSubmissionError`; retry only on pre-send failures (DNS/connect refused)
   or definitive rejection (4xx).
   **Redirects**: a read (by operation, `isReadOperation` in `client/operations.ts`, not by HTTP verb;
   unknown operations count as writes) is sent with `redirect: "manual"` and follows a 301/302/303/307/308
   itself, only when the `Location` (relative references resolved against the current URL) has the same
   origin (scheme, host, port) as the original request URL, never from https to http, and for at most 5
   hops (`client/redirect.ts`). The follow-up keeps the credential headers, which is safe because no other
   host sees them (undici strips only `Authorization`, `Cookie` and `Proxy-Authorization` across origins,
   so `SecretKey` would otherwise leak). Method and body follow the fetch standard: 301/302/307/308 keep
   them (so order-info, a read via PUT, is re-sent as the same PUT with its body), a 301/302 turns only a
   POST into a GET, and a 303 becomes a body-less GET. Anything else (another origin, a downgrade, a sixth
   hop, an unparsable or credential-bearing `Location`) is not followed and throws a non-retryable
   `NeweggApiError` whose `details.causeCode` is `REDIRECT_REFUSED_CROSS_ORIGIN`,
   `REDIRECT_REFUSED_DOWNGRADE`, `REDIRECT_REFUSED_TOO_MANY` or `REDIRECT_REFUSED_INVALID_LOCATION`.
   There is no `*.newegg.com` allowlist: a redirect to another Newegg host is cross-origin and refused. An
   http base URL is accepted only for loopback (tests), where a same-origin http redirect is followed. A 3xx
   without a `Location` is not a redirect and is mapped like any other non-2xx answer. Every other request is sent with
   `redirect: "error"`: a 3xx (301/302/307/308 alike) is never followed or retried and surfaces as a
   non-retryable error. Where the request may have reached the server, the write-specific indeterminate
   error applies (ADR 0004); the generic retrying path reports a non-retryable `NeweggApiError` that says
   the write may have been applied. `pricing.update` treats that redirect as an ambiguous failure (read-back,
   else `unknown`), never as `failed`.
6. **Rate limiting**: feed submissions locally budgeted at 10/min + 100,000 records/hour per
   `${marketplace}:${sellerId}`; 429/DF012 surface as `NeweggRateLimitError` with reset info.
7. **Secrets**: `Authorization`/`SecretKey` header values, apiKey, secretKey never appear in
   errors, logs, `raw` payloads, or serialized output. `raw` is sanitized (headers stripped).
8. **No network / credentials at import time.** Config validated in `createNeweggClient`
   (throws `NeweggConfigurationError`). **Credential binding (ADR 0006, contracts §2):** with
   `credentialMarketplace` set, a value other than `us`/`b2b`/`ca` is a `NeweggConfigurationError` and a value
   different from `marketplace` is a `NeweggMarketplaceMismatchError`, both before any request. Callers that
   omit the field keep the old, UNSAFE behaviour (a key pair from one seller account is served under any
   prefix). Defense in depth: `orders.list` (and `get`/`tryGet`) throws `NeweggMarketplaceMismatchError` when a
   non-empty page has a defined `currencyCode` on every order and none is the marketplace's (ca: CAD; us/b2b:
   USD, ASSUMPTION); empty, mixed and currency-less pages pass.
9. **ESM**, Node ≥ 22, relative imports carry `.js` extensions, no `any` in src.
10. **Orders (reads)**: `orders.list`/`get`/`tryGet`/`getStatus`/`tryGetStatus`/`listAdditionalInfo`/`getAdditionalInfo`/`tryGetAdditionalInfo` never mutate (additional info is a POST read, Newegg.com only, 10,000 req/hr, contracts §24).
    `list` and `get` share Get Order Information (version 315, 1000 req/hr); `getStatus` uses Get
    Order Status (version 304, 500 req/hr). Enum wire codes normalize to string unions,
    unrecognized → `"unknown"` (never throws). `get` throws `NeweggApiError` when no order
    matches (`tryGet` → `undefined`); `getStatus` throws on `SO003` (`tryGetStatus` → `undefined`).
    `pageSize` outside 1–100 or `page` < 1 throws `NeweggValidationError` (never silently clamped). `list` criteria
    Newegg rejects per platform (`countryCode`, `premierOrder`, `type: "nws"`: Newegg.com only, 400 CE003 on b2b/ca; contracts §10.1)
    throw `UnsupportedMarketplaceOperationError` BEFORE any request, never dropped silently; an invalid `isInternal`, an unknown
    `status` (including `"unknown"`) / `type` / `premierOrder` (never silently dropped), an empty or whitespace `countryCode`
    (rejected on every marketplace, before the per-platform check), or a `dateFrom` / `dateTo` / `lastUpdatedAfter` that is
    an invalid `Date` or a string not in `MM/DD/YYYY HH:mm:ss` or `YYYY-MM-DD HH:mm:ss` form throws `NeweggValidationError`
    before any request (all issues are reported together). `listAdditionalInfo` applies the same `status` (no
    `paymentPending`, which that endpoint reads as "All"), `dateFrom` / `dateTo` and `countryCode` checks.
    The MCP `newegg_orders_list` passes a zone-less date string through to the SDK unchanged (Pacific wall clock); only a
    string with `Z` or a numeric offset becomes a `Date`, so the machine's time zone never shifts the window. In MCP only, a
    bare `YYYY-MM-DD` expands to `00:00:00` (`dateFrom`, `lastUpdatedAfter`) or `23:59:59` (`dateTo`); the SDK itself stays strict.
11. **Order writes (non-idempotent)**: `orders.ship` (Action 2) / `cancel` (Action 1) /
    `confirmDownload` / `removeItems` (KillItem) mutate and follow ADR 0004 — a provably-unsent
    transport error retries, but an ambiguous failure (timeout/reset after dispatch, or 408/5xx)
    throws `IndeterminateOrderWriteError` and is never auto-resent (check order status first).
    `ship` treats the envelope `IsSuccess` as unreliable — the real outcome is `failCount` plus
    per-package `processStatus`. Bad input (non-integer order number, empty packages/items,
    duplicate seller part numbers) throws `NeweggValidationError` before any HTTP call.
12. **Storefront (UNOFFICIAL, read-only)**: `storefront.getOffers` reads the PUBLIC retail
    storefront (contracts §14), not the seller API. It bypasses the authenticated HTTP core
    entirely — no `sellerid` query, no `Authorization`/`SecretKey` headers, no rate-limit budget,
    no retry policy — and only borrows the client's `fetch` and `timeoutMs`. Browser-like
    headers (fixed UA + `Accept` + `Accept-Language` + `Referer`) are always sent or the CDN may
    block the call. Bodies arrive as `content-type: text/plain` containing JSON and are parsed by
    shape with a tolerant Zod v4 `looseObject` (unknown keys kept, scalars coerced via
    `schemas/wire.ts`). `buyBox` is `offers[0]` under a documented **ASSUMPTION**, and
    `shippingCharge` is raw (`0.01` ≠ paid shipping). Construction never throws: `b2b` fails at
    call time with `UnsupportedMarketplaceOperationError`.
13. **Pricing (reads)**: `pricing.get`/`tryGet`/`getMany` never mutate — Get Item Price is a READ on
    every platform even though US sends it as `PUT` (the same URL is a price WRITE on `POST`) and
    B2B/CAN as `POST` (contracts §15). The platform split (path, verb, country list, flat vs
    `PriceList` response) lives in `platform/`. Wire numbers/flags (strings or numbers, `"0"/"1"`),
    single-vs-array `Price` rows and a missing `OnPromotion` are normalized, never thrown on.
    B2B/CAN carry no `Currency`: it is inferred (`b2b` USD, `ca` CAD) and flagged
    `currencyInferred: true`. `getMany` is a client-side fan-out (batch-price pages unreadable,
    §15.4); inputs are validated with strict Zod v4 schemas (1–100 identifiers, uppercase alpha-3
    `countries`) before any HTTP call.
14. **Pricing (writes)**: `pricing.update` is the only price mutation. It sends ONLY the selling
    price (B2B/CA: `PUT …/inventoryandprice` with `{Type,Value,[Condition],SellingPrice}`; US:
    `POST …/international/price` with one `PriceList.Price` row) — never MAP, MSRP, shipping,
    `Active` or inventory. Prices are validated (>0, ≤99999.99, ≤2 decimals, never rounded;
    country/currency required on US, rejected elsewhere), de-duplicated last-write-wins, and
    written one request per item (≤100 per call, concurrency 2). A price assignment is absolute,
    so it is idempotent and ADR 0004's direct-operation retry applies; an ambiguous failure that
    survives retries is read back and reported per item as `verified` or `unknown`, never thrown.
    By default every write is read back (`verified`/`unverified`): Newegg silently ignores price
    updates to deactivated items while reporting success (contracts §6.2). `previewUpdate` only
    reads and returns blockers/warnings; the SDK's `update` does not enforce them — the MCP
    tools do (ADR 0005). The US write path is an unverified ASSUMPTION (contracts §16.4).
15. **Reference (reads)**: `reference.getSellerStatus`/`listIndustries`/`listSubcategories`/
    `listSubcategoryProperties`/`listPropertyValues` never mutate (contracts §19); the subcategory,
    property and property-value reads are `PUT` on the wire, which does not make them writes. The platform split (Seller Status Check's
    `version=307` on Newegg.com only, the international subcategory variant on Newegg.com only) lives
    in `platform/reference.ts`; `countryCode` on B2B/CAN throws
    `UnsupportedMarketplaceOperationError` before any request. Inputs are validated before sending
    (positive-integer ids, industry-code pattern, uppercase alpha-3 country, 1-200 character property
    name). Wire numbers/flags (strings, `"0"/"1"`), single-vs-array lists, `""` for an empty list and
    the Newegg.com `FufillmentCenterList` (sic) spelling are normalized, never thrown on; unknown
    status/membership codes degrade to `"unknown"`. A `200` whose body is a bare `[{Code, Message}]`
    list throws `NeweggApiError` rather than reading as an empty result. The seller-fulfilled Get
    Warehouse List and Get Subcategory Status v1.1 are not implemented (contracts §19.1); the SBN
    warehouse list is `sbn.listWarehouses` (item 17).
16. **RMA and courtesy refund writes (non-idempotent, money-moving)**: `rma.submit` / `edit` /
    `process` (receive) / `reject` and `refunds.issue` (contracts §20) each have a read-only
    `preview*` twin that reads the order, its RMAs and its courtesy refunds and returns
    `blockers` / `warnings` (the `SE0xx` rules mirrored locally). The write re-runs the same checks and
    throws `NeweggValidationError` on any blocker before any POST. Input is strict (zod 4): money is
    positive (shipping refund >= 0), at most 2 decimals and at most 99999.99 and is NEVER rounded or
    clamped; refund prices are forbidden on replacements; reasons 3/4/6/8 need `unopened` (+ images and
    memo on US/CA; images and memo are refused on B2B); the reject-reason set differs per marketplace
    (`platform/rma.ts`). Writes follow ADR 0004: only provably-unsent transport errors retry; a timeout
    or reset after dispatch, a caller abort after dispatch, an HTTP 408 or any 5xx (including 500), or a 2xx that does not identify the RMA / refund
    request throws `IndeterminateServiceWriteError` and is never auto-resent (read `rma.list/get` or
    `refunds.list/listRequests` first). Void / close RMA is not built (no documented operation).
    `autoReceive` exists in the SDK only. The MCP exposes preview + apply tools for all five, gated on
    `NEWEGG_MCP_ALLOW_WRITES=true`. The refund cap `NEWEGG_MCP_MAX_REFUND_AMOUNT` is MCP-only, applies to
    every refund total (RMA submit / edit / process and courtesy refund) and is per operation, not
    cumulative across previews; the SDK enforces only the schema maximum and the order-balance blockers.
    The checks fail closed (unknown order total, unreconcilable prior refunds, or a partial read of the
    order's RMAs / refunds block). A caller abort after dispatch is indeterminate too; a replacement RMA
    previews a `DiffShippedByPartyAction` warning (the field is never sent).
17. **SBN inbound shipments (reads)**: `sbn.listShipments`/`getRequestStatus`/`getRequestResult`/
    `listWarehouses` never mutate (contracts §21); the list, status and warehouse reads are `PUT` on the
    wire, which does not make them writes. Newegg.com and Newegg Business only: the availability check
    lives in `platform/sbn.ts` and `ca` throws `UnsupportedMarketplaceOperationError` before any request.
    Inputs are validated before sending (paging 1-100, request ids 1-64 alphanumeric, 1-3 digit
    warehouse code, valid dates). The shipment list carries no total, so `page`/`pageSize` echo the
    request and a full page may have more. Label download URLs of a request result may embed credentials
    (the samples show `ftp://` URLs, like the report files, §17.5): they are NEVER returned, logged or put
    in an error: `labels` holds `type`, `host` and `fileName` only and `raw` is redacted. Create / Void
    Inbound Shipment (writes) and Get Inbound Shipment Plan Suggestion (not shown to be side-effect free)
    are not implemented; their wire markers are blocked in the live read-only guard. Every verb/path is
    from the official pages and un-probed (contracts §21 **ASSUMPTION**s).
18. **Shipping labels (UPS; non-idempotent, spends money)**: `shippingLabels.create` BUYS a UPS label
    through the Shipping Label Service (contracts §23), bills the seller's Newegg account and ships the
    order; `shippingLabels.reprint` re-issues the label of a shipped order and is treated as billable;
    `shippingLabels.estimate` is a quote ("for estimation only", an **ASSUMPTION** that it has no side
    effect), so it is sent as a single attempt and never retried (a timeout or 5xx is reported). `previewCreate` / `previewReprint` read the order and return `blockers` / `warnings` mirroring
    `SL002`/`SL003`/`SL004`/`SL005`/`SL010`/`SL015`; the writes re-run them and throw
    `NeweggValidationError` on any blocker before any POST. Input is strict: order number 1..2147483647,
    service code of the marketplace (101-105 us/b2b, 111-114 ca), ZIP / postal code of the marketplace,
    UPS limits (150 lb, 108 in, length + 2 x width + 2 x height <= 165 in) checked locally. Writes follow
    ADR 0004: only a provably-unsent transport failure retries; a timeout or reset after dispatch, an
    abort after dispatch, HTTP 408 / any 5xx, or a 2xx with no (or another order's) package throws
    `IndeterminateOrderWriteError` and is never resent (check the order, then `reprint`). A request
    where some packages fail returns `failedCount > 0`; only an all-failed answer throws. There is no
    void or refund of a label in the documented API. **Duplicate-purchase ledger (T-6212):** `create`
    records an attempt per (marketplace, order number) in the client's `OperationStore` BEFORE dispatch
    (`submitting`), settles it `submitted` on a confirmed purchase and `failed` only when provably nothing was
    bought (never dispatched, HTTP 4xx, every package refused); an indeterminate outcome stays `submitting`.
    While a `submitting` or `submitted` record younger than 24 h exists, `previewCreate` adds a blocker and
    `priorAttempt`, and `create` throws `LabelCreateGuardError` (exported value; a `NeweggValidationError`
    with `orderNumber` and `attempt`) with nothing sent, re-checked after the order read and again by a
    synchronous claim, kept per `OperationStore` (not per client), so concurrent creates send one request even
    across clients on one store. `acknowledgePriorAttemptId` (the attempt's id, after the caller verified the
    order) clears that attempt only, never while the order lists a package; it is **not a human gate** (any
    code holding the id can pass it), which is why the MCP never offers it. Only a package that plainly says
    `Failed` (`ProcessResult`) with an error text counts as a refusal; `Pending` or an unfamiliar status keeps
    the record `submitting`. `assertCreateNotBlocked` checks the ledger alone, without any request. A
    record that cannot be written stops the purchase. Processes sharing one store (T-6280): `persist` re-reads the
    record right before writing and, when the store implements `compareAndPut` (`InMemoryOperationStore` does;
    the MCP's file store does), writes only if the record is still the one it read, so one claimant wins and the
    other gets `LabelCreateGuardError`; a store without it keeps a small read-then-write race. A store that
    cannot be read stops the operation with a `NeweggApiError`. The block window is `labelCreateGuardWindowMs`
    (client config, 1 hour to 30 days, default 24 hours). An unshipped order that already lists a package is a
    preview BLOCKER, no longer a warning. The MCP exposes
    `newegg_shipping_label_estimate` and the four preview / apply tools only with
    `NEWEGG_MCP_ALLOW_WRITES=true`; it returns label links only for `https://*.newegg.com`. The SDK has no
    cost ceiling; the MCP has `NEWEGG_MCP_MAX_LABEL_AMOUNT` (default 100, marketplace currency): the
    create preview carries the estimate and is blocked above the cap, apply checks the stored quote against
    the current cap and re-quotes and refuses above it, any cost that cannot be determined (failed or
    unrated quote, any reprint) is blocked, and only the explicit `unlimited` value disables the cap (a reprint alone can be
    allowed with `NEWEGG_MCP_ALLOW_LABEL_REPRINT=true`). Nothing was called live;
    every shape is from archived page samples (contracts §23 **ASSUMPTION**s).
19. **Sponsored Ads (reads)**: `ads.listCampaigns`/`listGroups`/`listProducts`/`listKeywords`/
    `listNegativeKeywords`/`listMatchTypes`, the suggestion reads `suggestKeywords`/
    `suggestCategoryTargeting`/`suggestItemTargeting`, and the synchronous `getGroupPerformance`/
    `getProductPerformance`/`getKeywordPerformance` never mutate (contracts §25). Every Sponsored Ads
    operation is a `POST` with a JSON body on the wire, which does not make it a write. Newegg.com
    and Newegg.ca: the availability check lives in `platform/ads.ts` and `b2b` throws
    `UnsupportedMarketplaceOperationError` before any request. Inputs are validated before sending
    (positive integer ids, `YYYY-MM-DD` dates, required dates on the performance reports, page size
    ceilings of 100 on the campaign / group / product / group-performance lists). Every method returns an
    `AdsPage<T>`; paging is explicit and nothing auto-pages. A 200 with no `rows` member is a
    `NeweggApiError` (never an empty page). The 15 create / add / update / change-status operations spend
    money and are not implemented; their URLs and reserved method names are blocked in the live
    read-only guard. Campaign Performance Report is the same URL as Campaign List, so `listCampaigns`
    covers it. Every shape is from the official pages and un-probed (contracts §25 **ASSUMPTION**s).

```

```
