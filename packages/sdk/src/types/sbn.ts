/** Shipped by Newegg (SBN) inbound-shipment types (contracts §21). Re-exported from `../types.ts`. */

import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// Shipped by Newegg (SBN) inbound-shipment reads (contracts §21)
// ----------------------------------------------------------------------------
/** What {@link ListSbnShipmentsInput.keyword} matches (`KeywordsType` 0-3). */
export type SbnShipmentKeywordType = "all" | "shipmentId" | "neweggItemNumber" | "sellerPartNumber";

/** Filter of {@link ListSbnShipmentsInput.status} (`Status` 0-6). */
export type SbnShipmentStatusFilter =
  "all" | "preparing" | "shipped" | "received" | "partiallyReceived" | "manuallyClosed" | "voided";

export interface ListSbnShipmentsInput {
  /** 1-based page (default 1). */
  page?: number;
  /** Rows per page, 1-100 (default 100). */
  pageSize?: number;
  /** What `keyword` matches (default `"all"`). */
  keywordType?: SbnShipmentKeywordType;
  /** Value to match for `keywordType`. */
  keyword?: string;
  /** Shipment status filter (default `"all"`). */
  status?: SbnShipmentStatusFilter;
  /** Start of the last-update range. A `Date` is sent as Pacific time; a string verbatim. */
  updatedFrom?: Date | string;
  /** End of the last-update range (inclusive). With both bounds empty Newegg uses the last 30 days. */
  updatedTo?: Date | string;
}

/** A warehouse address (inbound shipment destination or SBN warehouse record). */
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

/** One inbound shipment. */
export interface SbnShipment {
  shipmentId: string;
  /** Newegg's status text, e.g. "Preparing", "Ready to ship", "Shipped", "Received", "Void". */
  status?: string;
  createdAt?: { raw: string; iso?: string };
  lastEditedAt?: { raw: string; iso?: string };
  shipFrom?: string;
  /** Newegg warehouse code the shipment is going to (e.g. "14"). */
  shipToWarehouseCode?: string;
  shipTo: SbnAddress;
  /** `ShippingMethodCode`: 1 small parcel, 2 less-than-truckload; any other value stays undefined. */
  shippingMethod?: "smallParcel" | "lessThanTruckload";
  /** `ShippingCarrierCode` as sent (101 DHL, 102 FedEx, 103 UPS, 104 USPS, 105 Newegg UPS, 99 other). */
  carrierCode?: number;
  /** Carrier name for a known code, else `OtherCarrierName`. */
  carrier?: string;
  packages: SbnShipmentPackage[];
  items: SbnShipmentItem[];
}

/** Result of {@link SbnApi.listShipments}. */
export interface SbnShipmentsResult {
  marketplace: NeweggMarketplace;
  /** Echo of the requested paging; the response carries no total, so a full page may have more. */
  page: number;
  pageSize: number;
  shipments: SbnShipment[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

export type SbnRequestAction = "all" | "create" | "void";

/** Submission-status filter of Get Inbound Shipment Status Request. */
export type SbnRequestStatusFilter = "ALL" | "SUBMITTED" | "IN_PROGRESS" | "FINISHED" | "CANCELLED";

export interface GetSbnRequestStatusInput {
  /** Look up these submissions; Newegg ignores every other filter when ids are given. */
  requestIds?: string[];
  /** Create or void submissions only (default `"all"`). */
  action?: SbnRequestAction;
  /** Maximum records, 1-100 (default 100). */
  maxCount?: number;
  /** Submission status filter (default `"ALL"`). */
  requestStatus?: SbnRequestStatusFilter;
  requestDateFrom?: Date | string;
  requestDateTo?: Date | string;
}

/** One inbound-shipment create/void submission. */
export interface SbnRequestStatusEntry {
  requestId: string;
  action?: "create" | "void";
  requestedAt?: { raw: string; iso?: string };
  /** SUBMITTED, IN_PROGRESS, FINISHED or CANCELLED (as sent). */
  status?: string;
  /** Newegg's error detail for a failed submission. */
  memo?: string;
}

/** Result of {@link SbnApi.getRequestStatus}. */
export interface SbnRequestStatusResult {
  marketplace: NeweggMarketplace;
  requests: SbnRequestStatusEntry[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** A label Newegg generated for a processed shipment request. The download URL is never exposed. */
export interface SbnShipmentLabel {
  /** ItemLabel, PackageLabel, ShippingLabel or PackingListLabel (as sent). */
  type?: string;
  /** Host of the label file; the full URL may embed credentials and is dropped. */
  host?: string;
  fileName?: string;
}

/** Result of {@link SbnApi.getRequestResult}. */
export interface SbnRequestResult {
  marketplace: NeweggMarketplace;
  requestId: string;
  requestedAt?: { raw: string; iso?: string };
  processedAt?: { raw: string; iso?: string };
  status?: string;
  /** Present once the request produced a shipment. */
  shipmentId?: string;
  labels: SbnShipmentLabel[];
  /** Error text Newegg attached to the request, if any. */
  errors: string[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  /** Sanitized raw payload (any credential-bearing URL is redacted). */
  raw?: unknown;
}

export interface ListSbnWarehousesInput {
  /** One Newegg SBN warehouse code (e.g. "10"); omit to request every warehouse (unconfirmed, §21.5). */
  warehouseCode?: string;
}

/** A Newegg warehouse that accepts SBN inbound shipments. */
export interface SbnWarehouse {
  warehouseCode: string;
  allowBulkItem?: boolean;
  allowSmallItem?: boolean;
  address: SbnAddress;
}

/** Result of {@link SbnApi.listWarehouses}. */
export interface SbnWarehousesResult {
  marketplace: NeweggMarketplace;
  warehouses: SbnWarehouse[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/**
 * Shipped-by-Newegg inbound-shipment reads (contracts §21). Newegg.com and Newegg Business only:
 * on CAN every method throws {@link UnsupportedMarketplaceOperationError} before sending. All are
 * READS (three via `PUT`); creating and voiding inbound shipments is intentionally not implemented.
 */
export interface SbnApi {
  /** Get Inbound Shipment List (500 req/hr). */
  listShipments(
    input?: ListSbnShipmentsInput,
    options?: RequestOptions,
  ): Promise<SbnShipmentsResult>;
  /** Get Inbound Shipment Status Request: the status of create/void submissions (1,000 req/min). */
  getRequestStatus(
    input?: GetSbnRequestStatusInput,
    options?: RequestOptions,
  ): Promise<SbnRequestStatusResult>;
  /** Get Inbound Shipment Request Result: the outcome and labels of one submission (500 req/hr). */
  getRequestResult(requestId: string, options?: RequestOptions): Promise<SbnRequestResult>;
  /** Get Warehouse List: Newegg's SBN inbound warehouses (1,000 req/min). */
  listWarehouses(
    input?: ListSbnWarehousesInput,
    options?: RequestOptions,
  ): Promise<SbnWarehousesResult>;
}
