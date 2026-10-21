/** RMA and courtesy refund read and write types (contracts §18, §20). Re-exported from `../types.ts`. */

import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { ShipToAddress } from "./orders.js";
import type { RateLimitInfo } from "./runtime.js";

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

// ----------------------------------------------------------------------------
// RMA and courtesy refund WRITES (contracts §20)
// ----------------------------------------------------------------------------
/**
 * Per-item reason when SUBMITTING or EDITING an RMA (`RMAReason` 1-10 in the request; the response
 * list is the 1-9 {@link RmaReason}). Reasons `incompatible`, `noLongerNeeded`, `orderedWrongItem` and
 * `unsatisfied` require the `unopened` flag and, on Newegg.com / Newegg.ca, a memo and 1-5 image URLs.
 */
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

/** One returned line of a submitted or edited RMA (`RMATransaction`). */
export interface RmaWriteItem {
  /** Seller part number of an item on the order. */
  sellerPartNumber: string;
  /** Units returned (> 0, at most the returnable quantity). */
  returnQuantity: number;
  reason: RmaWriteReason;
  /**
   * Refund RMAs (required there, forbidden on replacements): refund per unit, > 0, at most 2
   * decimals, at most the item's unit price. In the marketplace currency.
   */
  returnUnitPrice?: number;
  /** Refund RMAs (required there, forbidden on replacements): shipping refund for the line, >= 0. */
  refundShippingPrice?: number;
  /** `UnOpen`: required for reasons incompatible / noLongerNeeded / orderedWrongItem / unsatisfied. */
  unopened?: boolean;
  /** Evidence image URLs (1-5, http(s)). Newegg.com and Newegg.ca only. */
  imageUrls?: string[];
  /** Evidence memo (<= 1000). Newegg.com and Newegg.ca only. */
  memo?: string;
}

/** Input to {@link RmaApi.submit} / {@link RmaApi.previewSubmit} (Submit RMA; contracts §20.2). */
export interface SubmitRmaInput {
  /** The order the RMA is issued for (digits). */
  orderNumber: string | number;
  type: Exclude<RmaType, "unknown">;
  items: RmaWriteItem[];
  /** Seller-defined RMA number: letters and digits only, <= 50. */
  sellerRmaNumber?: string;
  /** RMA comment, <= 4000. */
  note?: string;
  /**
   * Receive the RMA on creation (`AutoReceiveMark` = 1): refund RMAs only.
   * This FINALIZES the refund in the same call. Default false.
   */
  autoReceive?: boolean;
}

/** Input to {@link RmaApi.edit} / {@link RmaApi.previewEdit} (Edit RMA; contracts §20.3). */
export interface EditRmaInput {
  rmaNumber: string | number;
  /** Must equal the RMA's existing type. */
  type: Exclude<RmaType, "unknown">;
  /** Required by Newegg, <= 4000. */
  note: string;
  items: RmaWriteItem[];
  sellerRmaNumber?: string;
}

/** Input to {@link RmaApi.process} / {@link RmaApi.previewProcess} (Process RMA = receive; §20.3). */
export interface ProcessRmaInput {
  rmaNumber: string | number;
}

/** Why a seller rejects a returned item (`RejectReason`; availability differs by marketplace). */
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

/** Carrier the rejected item is shipped back with (`ShipCarrier` 1-5). */
export type RmaRejectCarrier = "ups" | "fedex" | "dhl" | "usps" | "other";

/** Input to {@link RmaApi.reject} / {@link RmaApi.previewReject} (Reject RMA; contracts §20.3). */
export interface RejectRmaInput {
  rmaNumber: string | number;
  reason: RmaRejectReason;
  carrier: RmaRejectCarrier;
  /** Required when `carrier` is `"other"`, <= 10. */
  otherCarrier?: string;
  /** Shipping service, <= 50. */
  shipService: string;
  /** One or more tracking numbers of the shipment back to the customer. */
  trackingNumbers: string[];
  /** Required for reasons itemMissing, cpuPinDamage .. motherboardSocketPinDamage; <= 1000. */
  memo?: string;
  /** Required with the memo above: 1-5 http(s) image URLs. */
  imageUrls?: string[];
}

/** Input to {@link RefundsApi.issue} / {@link RefundsApi.previewIssue} (Issue Courtesy Refund; §20.5). */
export interface IssueCourtesyRefundInput {
  orderNumber: string | number;
  reason: Exclude<CourtesyRefundReason, "unknown">;
  /** > 0, at most 2 decimals, at most the order total minus prior refunds. In the marketplace currency. */
  amount: number;
  /** Note shown to the customer, <= 500. */
  noteToCustomer?: string;
}

/** Which write a preview or a thrown indeterminate error refers to. */
export type ServiceWriteOperation =
  "rma.submit" | "rma.edit" | "rma.receive" | "rma.reject" | "refunds.issue";

/**
 * The read-only plan for an RMA / courtesy-refund write: the validated, normalized input, the
 * money it would move, and every blocker and warning found by reading the order, its RMAs and its
 * courtesy refunds. A write is allowed only when `blockers` is empty; `submit` / `edit` / `process`
 * / `reject` / `issue` re-run the same checks and throw {@link NeweggValidationError} otherwise.
 * No Newegg mutation happens while building it.
 */
export interface ServiceWritePreview<N> {
  marketplace: NeweggMarketplace;
  operation: ServiceWriteOperation;
  /** The exact input a later write would send. Round-trips straight into the write method. */
  normalized: N;
  currency: RmaCurrency;
  /** Money the write moves (refund RMA total, or the courtesy refund); undefined when it moves none. */
  refundTotal?: number;
  /** Order number the write concerns, when known. */
  orderNumber?: string;
  /** Reasons the write MUST NOT be sent. */
  blockers: string[];
  /** Things worth a human look; they do not stop the write. */
  warnings: string[];
  correlationId: string;
}

/** Result of a successful RMA write (Submit / Edit / Process / Reject RMA). */
export interface RmaWriteResult {
  marketplace: NeweggMarketplace;
  operation: Exclude<ServiceWriteOperation, "refunds.issue">;
  rmaNumber: string;
  type: RmaType;
  /** Status Newegg reports right after the write (normally `processing`). */
  status: RmaStatus;
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

/** Result of {@link RefundsApi.issue}: the refund is asynchronous - poll {@link RefundsApi.getRequestStatus}. */
export interface CourtesyRefundIssueResult {
  marketplace: NeweggMarketplace;
  /** Id for {@link RefundsApi.getRequestStatus}. */
  requestId: string;
  requestDate?: { raw: string; iso?: string };
  /** Normally `submitted`; the final state arrives through the status read. */
  state: CourtesyRefundRequestState;
  /** The wire `RequestStatus` label as returned. */
  stateRaw?: string;
  memo?: string;
  orderNumber: string;
  amount: number;
  currency: RmaCurrency;
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/**
 * RMA reads (Get RMA Information, 1000 req/hr) plus the RMA WRITES (contracts §20). The reads never
 * mutate. Every write has a `preview*` twin that only READS (the order, its RMAs, its courtesy
 * refunds) and reports blockers; the write re-runs those checks and throws
 * {@link NeweggValidationError} on any blocker. Writes are NOT idempotent: an ambiguous failure throws
 * {@link IndeterminateServiceWriteError} and is never retried.
 */
export interface RmaApi {
  /** Search RMAs (single page). Omit `input` to match all RMAs. */
  list(input?: ListRmasInput, options?: RequestOptions): Promise<RmasPage>;
  /** Fetch one RMA by its Newegg RMA number. Throws {@link NeweggApiError} when none matches. */
  get(rmaNumber: string | number, options?: RequestOptions): Promise<Rma>;
  /** Like {@link RmaApi.get} but resolves to `undefined` when no RMA matches. */
  tryGet(rmaNumber: string | number, options?: RequestOptions): Promise<Rma | undefined>;
  /** Plan a Submit RMA. Reads only. */
  previewSubmit(
    input: SubmitRmaInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<SubmitRmaInput>>;
  /** Submit an RMA (WRITE; 100 req/hr). A refund RMA records a refund to the customer. */
  submit(input: SubmitRmaInput, options?: RequestOptions): Promise<RmaWriteResult>;
  /** Plan an Edit RMA. Reads only. */
  previewEdit(
    input: EditRmaInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<EditRmaInput>>;
  /** Edit an open RMA (WRITE; 1000 req/hr). Changes the refund the customer is owed. */
  edit(input: EditRmaInput, options?: RequestOptions): Promise<RmaWriteResult>;
  /** Plan a Process (receive) RMA. Reads only. */
  previewProcess(
    input: ProcessRmaInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<ProcessRmaInput>>;
  /** Mark an RMA's items as received (WRITE; 1000 req/hr). Receiving a refund RMA lets Newegg pay the refund (ASSUMPTION, contracts §20.7). */
  process(input: ProcessRmaInput, options?: RequestOptions): Promise<RmaWriteResult>;
  /** Plan a Reject RMA. Reads only. */
  previewReject(
    input: RejectRmaInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<RejectRmaInput>>;
  /** Reject a returned item and ship it back (WRITE; 1000 req/hr). Denies the customer's refund. */
  reject(input: RejectRmaInput, options?: RequestOptions): Promise<RmaWriteResult>;
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
 * Status 10,000 req/hr) plus Issue Courtesy Refund (WRITE, 1000 req/hr; contracts §20.5), which pays
 * the customer. Like the RMA writes it has a read-only `previewIssue` twin, is NOT idempotent and
 * throws {@link IndeterminateServiceWriteError} on an ambiguous failure instead of retrying.
 */
export interface RefundsApi {
  /** Plan an Issue Courtesy Refund. Reads only. */
  previewIssue(
    input: IssueCourtesyRefundInput,
    options?: RequestOptions,
  ): Promise<ServiceWritePreview<IssueCourtesyRefundInput>>;
  /** Issue a courtesy refund (WRITE). Asynchronous: follow it with {@link RefundsApi.getRequestStatus}. */
  issue(
    input: IssueCourtesyRefundInput,
    options?: RequestOptions,
  ): Promise<CourtesyRefundIssueResult>;
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
