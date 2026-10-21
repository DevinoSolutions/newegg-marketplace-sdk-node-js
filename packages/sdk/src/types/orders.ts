/** Order types (read-only). Re-exported from `../types.ts`. */

import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { RateLimitInfo } from "./runtime.js";

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
  /**
   * Filter by fulfillment/channel type (`Type`). Default `"all"` on the wire. `"nws"` is Newegg.com
   * (`us`) only and throws {@link UnsupportedMarketplaceOperationError} on `ca`/`b2b`.
   */
  type?: OrderTypeFilter;
  /** `false` excludes already-downloaded orders (`OrderDownloaded=1`). Default includes all. */
  includeDownloaded?: boolean;
  /**
   * Premier-order filter (`PremierOrder`). Newegg.com (`us`) only: on `ca`/`b2b` Newegg answers
   * 400 CE003, so the SDK throws {@link UnsupportedMarketplaceOperationError} before any request.
   */
  premierOrder?: PremierOrderFilter;
  /** Lower bound on order date. `Date` is rendered as Pacific Time; a string is sent verbatim. */
  dateFrom?: Date | string;
  /** Upper bound on order date (see {@link ListOrdersInput.dateFrom}). */
  dateTo?: Date | string;
  /**
   * ISO 3-digit ship-to country code (`CountryCode`). Newegg.com (`us`) only: throws
   * {@link UnsupportedMarketplaceOperationError} on `ca`/`b2b` (Newegg answers 400 CE003).
   */
  countryCode?: string;
  /**
   * Orders last updated after this instant (`LastUpdatedAfter`). A `Date` is rendered as Pacific Time; a
   * string is sent verbatim (`MM/DD/YYYY HH:mm:ss` or `YYYY-MM-DD HH:mm:ss`, Pacific). Valid on every
   * marketplace (wire format verified live 2026-10-21; the exact "updated" semantics are an ASSUMPTION).
   */
  lastUpdatedAfter?: Date | string;
  /**
   * `IsInternal`, sent as `1` / `0`. Valid on every marketplace, but its meaning is UNDOCUMENTED and
   * UNVERIFIED: both values returned every order on the CA account (2026-10-21). Do not rely on it to
   * include or exclude anything.
   */
  isInternal?: boolean;
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

/** Recipient details as Newegg stores them for an additional-info record (contracts §24). */
export interface AdditionalOrderRecipient {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  stateCode?: string;
  zipCode?: string;
  countryCode?: string;
  phoneNumber?: string;
}

/**
 * One order's extra compliance data from Get Additional Order Information (contracts §24):
 * recipient identity document, the original (pre-NISP / as-entered) recipient addresses, and the
 * China tax/import designations. Contains personal data (ID numbers, ID image links).
 */
export interface AdditionalOrderInfo {
  orderNumber: string;
  /** Customer ID document type (e.g. `CPF`, `CNPJ`, `Passport`, `Identification Card`). */
  recipientIdType?: string;
  recipientIdNumber?: string;
  /** Original recipient for NISP-shipped orders. */
  nispOriginal?: AdditionalOrderRecipient;
  /** Recipient exactly as the customer entered it. */
  originalInput?: AdditionalOrderRecipient;
  /** `DDU` / `DDP` / `ATI` / `Default`. */
  taxDutyTypeChina?: string;
  /** `EE` / `EEP` / `Default`. */
  importTypeChina?: string;
  idCopyFront?: string;
  idCopyBack?: string;
  /** Non-empty `AddInfo1`-`AddInfo3` values (reserved by Newegg; usually none). */
  reserved: string[];
}

/** Criteria for {@link OrdersApi.listAdditionalInfo}; same filter semantics as {@link ListOrdersInput}. */
export interface ListAdditionalOrderInfoInput {
  orderNumbers?: Array<string | number>;
  status?: Exclude<OrderStatus, "unknown" | "paymentPending">;
  /** Wire `Type` 0/1/2/3 (`nisp` here, unlike Get Order Information's codes 3/4). */
  type?: "all" | "sbn" | "sbs" | "nisp";
  includeDownloaded?: boolean;
  dateFrom?: Date | string;
  dateTo?: Date | string;
  /** ISO 3-letter country code. */
  countryCode?: string;
  page?: number;
  pageSize?: number;
}

/** One page of {@link OrdersApi.listAdditionalInfo} results. */
export interface AdditionalOrderInfoPage {
  marketplace: NeweggMarketplace;
  records: AdditionalOrderInfo[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
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
   * Get Additional Order Information (contracts §24 - a READ despite the POST): recipient ID
   * document, original recipient addresses and China tax/import designations. Newegg.com only;
   * B2B and CAN throw {@link UnsupportedMarketplaceOperationError} before sending (ADR 0002).
   */
  listAdditionalInfo(
    input?: ListAdditionalOrderInfoInput,
    options?: RequestOptions,
  ): Promise<AdditionalOrderInfoPage>;
  /** Additional info for one order; throws {@link NeweggError} when none is returned. */
  getAdditionalInfo(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<AdditionalOrderInfo>;
  /** Like {@link OrdersApi.getAdditionalInfo} but resolves to `undefined` when not found. */
  tryGetAdditionalInfo(
    orderNumber: string | number,
    options?: RequestOptions,
  ): Promise<AdditionalOrderInfo | undefined>;
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
