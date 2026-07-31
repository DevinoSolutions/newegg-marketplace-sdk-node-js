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
  /** Trusted-config-only override (tests, proxies). Never exposed via MCP. */
  baseUrl?: string;
  timeoutMs?: number; // default 30_000
  userAgent?: string; // default "newegg-marketplace-sdk/<version> node/<version>"
  retry?: RetryOptions;
  logger?: NeweggLogger;
  fetch?: typeof globalThis.fetch;
  rateLimitStore?: RateLimitStore;
  operationStore?: OperationStore;
  strategy?: {
    /** updateMany "auto" switches to feeds at > this many post-dedup items. Default 8. SDK policy, not a Newegg rule. */
    autoFeedThreshold?: number;
  };
  /** Optional app-level quantity ceiling; SDK never clamps silently — violation => NeweggValidationError. */
  maxQuantity?: number;
}

export interface NeweggClient {
  readonly marketplace: NeweggMarketplace;
  readonly inventory: InventoryApi;
  readonly feeds: FeedsApi;
  readonly service: ServiceApi;
  readonly orders: OrdersApi; // order reads (list / get / status) + writes (ship / cancel / confirm / remove)
  readonly catalog: CatalogApi; // read-only catalog resolution (Item Lookup Report, contracts §12)
  readonly listings: ListingsApi; // WRITE: existing-item listing creation (ITEM_DATA&v2 feed, contracts §13)
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
  status?: OrderStatus;
  type?: OrderTypeFilter; // default "all" on the wire
  includeDownloaded?: boolean; // false => exclude already-downloaded (OrderDownloaded=1)
  premierOrder?: PremierOrderFilter;
  dateFrom?: Date | string; // Date => rendered Pacific; string sent verbatim
  dateTo?: Date | string;
  countryCode?: string; // ISO 3-digit
  page?: number; // PageIndex, default 1
  pageSize?: number; // PageSize, max 100, default 100
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
  emailAddress?: string; // masked Newegg relay (…@marketplace.newegg.com), never the real email
  shipTo?: ShipToAddress;
}
export interface OrderAmounts {
  // each a decimal in Order.currencyCode
  itemAmount?: number;
  shippingAmount?: number;
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
  currencyCode?: string;
  customer?: OrderCustomer;
  shipService?: string;
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
  getStatus(orderNumber: string | number, options?: RequestOptions): Promise<OrderStatusSnapshot>; // throws SO003
  tryGetStatus(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<OrderStatusSnapshot | undefined>; // SO003 => undefined
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
 * sellerIdHash (sha256 prefix, never the raw seller ID), durationMs where relevant.
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
  readonly details?: unknown; // sanitized, JSON-safe
}
export class NeweggConfigurationError extends NeweggError {}
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
6. **Rate limiting**: feed submissions locally budgeted at 10/min + 100,000 records/hour per
   `${marketplace}:${sellerId}`; 429/DF012 surface as `NeweggRateLimitError` with reset info.
7. **Secrets**: `Authorization`/`SecretKey` header values, apiKey, secretKey never appear in
   errors, logs, `raw` payloads, or serialized output. `raw` is sanitized (headers stripped).
8. **No network / credentials at import time.** Config validated in `createNeweggClient`
   (throws `NeweggConfigurationError`).
9. **ESM**, Node ≥ 22, relative imports carry `.js` extensions, no `any` in src.
10. **Orders (reads)**: `orders.list`/`get`/`tryGet`/`getStatus`/`tryGetStatus` never mutate.
    `list` and `get` share Get Order Information (version 315, 1000 req/hr); `getStatus` uses Get
    Order Status (version 304, 500 req/hr). Enum wire codes normalize to string unions,
    unrecognized → `"unknown"` (never throws). `get` throws `NeweggApiError` when no order
    matches (`tryGet` → `undefined`); `getStatus` throws on `SO003` (`tryGetStatus` → `undefined`).
    `pageSize` outside 1–100 or `page` < 1 throws `NeweggValidationError` (never silently clamped).
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

```

```
