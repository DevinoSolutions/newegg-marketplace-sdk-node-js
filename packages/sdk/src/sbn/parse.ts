/**
 * Pure request builders and tolerant response parsers for the Shipped-by-Newegg (SBN) inbound
 * shipment reads (contracts §21). Free of transport concerns so they can be unit-tested against raw
 * wire fixtures. Every reader tolerates Newegg's quirks: numbers as strings, booleans as
 * "0"/"1"/"true", single-element lists as objects (or bare strings) instead of arrays, empty
 * lists as `""`, and the optional `NeweggAPIResponse` wrapper.
 */
import type {
  GetSbnRequestStatusInput,
  ListSbnShipmentsInput,
  ListSbnWarehousesInput,
  SbnAddress,
  SbnRequestAction,
  SbnRequestStatusEntry,
  SbnRequestStatusFilter,
  SbnShipment,
  SbnShipmentItem,
  SbnShipmentKeywordType,
  SbnShipmentLabel,
  SbnShipmentPackage,
  SbnShipmentStatusFilter,
  SbnWarehouse,
} from "../types.js";
import { NeweggApiError } from "../errors/index.js";
import type { NeweggValidationIssue } from "../errors/index.js";
import { toTimestamp } from "../platform/dates.js";
import { asArray, asBoolean, asNumber, asString, getField, isRecord } from "../schemas/wire.js";
import { describeReportFile } from "../reportmgmt/redact.js";
import {
  checkCriteriaDate,
  listItems,
  renderCriteriaDate,
  resolvePaging,
  throwIfInvalid,
  unwrapResponse,
} from "../servicemgmt/shared.js";
import {
  SBN_SHIPMENT_LIST_OPERATION_TYPE,
  SBN_SHIPMENT_STATUS_OPERATION_TYPE,
  SBN_STATUS_MAX_COUNT,
  SBN_WAREHOUSE_OPERATION_TYPE,
} from "./constants.js";

// ---------------------------------------------------------------------------
// input validation + request builders
// ---------------------------------------------------------------------------
const REQUEST_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
const WAREHOUSE_CODE_PATTERN = /^\d{1,3}$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const MAX_KEYWORD_LENGTH = 100;
const MAX_REQUEST_IDS = 100;

const KEYWORD_TYPE_CODES: Readonly<Record<SbnShipmentKeywordType, number>> = {
  all: 0,
  shipmentId: 1,
  neweggItemNumber: 2,
  sellerPartNumber: 3,
};

const SHIPMENT_STATUS_CODES: Readonly<Record<SbnShipmentStatusFilter, number>> = {
  all: 0,
  preparing: 1,
  shipped: 2,
  received: 3,
  partiallyReceived: 4,
  manuallyClosed: 5,
  voided: 6,
};

const REQUEST_ACTION_CODES: Readonly<Record<SbnRequestAction, number>> = {
  all: 0,
  create: 1,
  void: 2,
};

const REQUEST_STATUS_FILTERS: ReadonlySet<string> = new Set<SbnRequestStatusFilter>([
  "ALL",
  "SUBMITTED",
  "IN_PROGRESS",
  "FINISHED",
  "CANCELLED",
]);

function checkRequestId(value: unknown, path: string, issues: NeweggValidationIssue[]): void {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    issues.push({ path, message: "must be 1-64 letters or digits" });
  }
}

/** Validates a standalone request id argument (throws {@link NeweggValidationError}). */
export function validateSbnRequestId(requestId: string): string {
  const issues: NeweggValidationIssue[] = [];
  checkRequestId(requestId, "requestId", issues);
  throwIfInvalid("Invalid inbound shipment request.", issues);
  return requestId;
}

export interface BuiltShipmentListRequest {
  body: unknown;
  page: number;
  pageSize: number;
}

/**
 * Body of Get Inbound Shipment List. Follows the official JSON sample: paging nests under
 * `PageInfo`, every other filter sits directly under `RequestBody`. Absent filters are omitted
 * (Newegg defaults: all keywords, all statuses, the last 30 days).
 */
export function buildShipmentListRequest(input: ListSbnShipmentsInput): BuiltShipmentListRequest {
  const issues: NeweggValidationIssue[] = [];
  const paging = resolvePaging(input.page, input.pageSize, issues);
  const { keywordType, keyword, status, updatedFrom, updatedTo } = input;
  if (keywordType !== undefined && !(keywordType in KEYWORD_TYPE_CODES)) {
    issues.push({ path: "keywordType", message: "is not a supported keyword type" });
  }
  if (status !== undefined && !(status in SHIPMENT_STATUS_CODES)) {
    issues.push({ path: "status", message: "is not a supported shipment status" });
  }
  if (keyword !== undefined) {
    const trimmed = typeof keyword === "string" ? keyword.trim() : "";
    if (trimmed === "" || trimmed.length > MAX_KEYWORD_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
      issues.push({
        path: "keyword",
        message: `must be 1-${MAX_KEYWORD_LENGTH} characters without control characters`,
      });
    }
  }
  checkCriteriaDate(updatedFrom, "updatedFrom", issues);
  checkCriteriaDate(updatedTo, "updatedTo", issues);
  throwIfInvalid("Invalid inbound shipment list request.", issues);

  const requestBody: Record<string, unknown> = {
    PageInfo: { PageIndex: paging.pageIndex, PageSize: paging.pageSize },
  };
  if (keywordType !== undefined) requestBody.KeywordsType = KEYWORD_TYPE_CODES[keywordType];
  if (keyword !== undefined) requestBody.KeywordsValue = keyword.trim();
  if (status !== undefined) requestBody.Status = SHIPMENT_STATUS_CODES[status];
  if (updatedFrom !== undefined) requestBody.LastUpdateDateFrom = renderCriteriaDate(updatedFrom);
  if (updatedTo !== undefined) requestBody.LastUpdateDateTo = renderCriteriaDate(updatedTo);
  return {
    body: { OperationType: SBN_SHIPMENT_LIST_OPERATION_TYPE, RequestBody: requestBody },
    page: paging.pageIndex,
    pageSize: paging.pageSize,
  };
}

/**
 * Body of Get Inbound Shipment Status Request. Follows the official JSON sample: the filters nest
 * under `RequestBody.GetRequestStatus` (ids as `RequestIDList.RequestID[]`). Absent filters are
 * omitted (Newegg defaults: all actions, 100 records, status ALL).
 */
export function buildShipmentStatusBody(input: GetSbnRequestStatusInput): unknown {
  const issues: NeweggValidationIssue[] = [];
  const { requestIds, action, maxCount, requestStatus, requestDateFrom, requestDateTo } = input;
  if (requestIds !== undefined) {
    if (
      !Array.isArray(requestIds) ||
      requestIds.length < 1 ||
      requestIds.length > MAX_REQUEST_IDS
    ) {
      issues.push({
        path: "requestIds",
        message: `must be an array of 1-${MAX_REQUEST_IDS} request ids`,
      });
    } else {
      requestIds.forEach((id, i) => checkRequestId(id, `requestIds.${i}`, issues));
    }
  }
  if (action !== undefined && !(action in REQUEST_ACTION_CODES)) {
    issues.push({ path: "action", message: "is not a supported request action" });
  }
  if (
    maxCount !== undefined &&
    (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > SBN_STATUS_MAX_COUNT)
  ) {
    issues.push({
      path: "maxCount",
      message: `must be an integer between 1 and ${SBN_STATUS_MAX_COUNT}`,
    });
  }
  if (requestStatus !== undefined && !REQUEST_STATUS_FILTERS.has(requestStatus)) {
    issues.push({ path: "requestStatus", message: "is not a supported request status" });
  }
  checkCriteriaDate(requestDateFrom, "requestDateFrom", issues);
  checkCriteriaDate(requestDateTo, "requestDateTo", issues);
  throwIfInvalid("Invalid inbound shipment status request.", issues);

  const filter: Record<string, unknown> = {};
  if (requestIds !== undefined) filter.RequestIDList = { RequestID: [...requestIds] };
  if (action !== undefined) filter.ActionCode = REQUEST_ACTION_CODES[action];
  if (maxCount !== undefined) filter.MaxCount = maxCount;
  if (requestStatus !== undefined) filter.RequestStatus = requestStatus;
  if (requestDateFrom !== undefined) filter.RequestDateFrom = renderCriteriaDate(requestDateFrom);
  if (requestDateTo !== undefined) filter.RequestDateTo = renderCriteriaDate(requestDateTo);
  return {
    OperationType: SBN_SHIPMENT_STATUS_OPERATION_TYPE,
    RequestBody: { GetRequestStatus: filter },
  };
}

/** Body of Get Warehouse List (`WarehouseCode` is optional; sent as a string like the sample). */
export function buildWarehouseBody(input: ListSbnWarehousesInput): unknown {
  const issues: NeweggValidationIssue[] = [];
  const { warehouseCode } = input;
  if (warehouseCode !== undefined && !WAREHOUSE_CODE_PATTERN.test(warehouseCode)) {
    issues.push({ path: "warehouseCode", message: "must be a 1-3 digit warehouse code" });
  }
  throwIfInvalid("Invalid warehouse request.", issues);
  const requestBody: Record<string, unknown> = {};
  if (warehouseCode !== undefined) requestBody.WarehouseCode = warehouseCode;
  return { OperationType: SBN_WAREHOUSE_OPERATION_TYPE, RequestBody: requestBody };
}

// ---------------------------------------------------------------------------
// response helpers
// ---------------------------------------------------------------------------
/**
 * Unwraps the response and turns a 200 whose body is a bare error list (`[{Code, Message}]`)
 * into a {@link NeweggApiError}, so an error can never read as an empty result.
 */
function unwrapSbn(json: unknown, correlationId: string): unknown {
  if (Array.isArray(json)) {
    const first = json.find(isRecord);
    const code = asString(getField(first, "Code"));
    if (code !== undefined) {
      throw new NeweggApiError(`Newegg returned an error list (${code}).`, {
        correlationId,
        neweggErrorCode: code,
        details: { message: asString(getField(first, "Message")) },
      });
    }
  }
  return unwrapResponse(json, correlationId).body;
}

function text(value: unknown): string | undefined {
  const s = asString(value)?.trim();
  return s === undefined || s === "" ? undefined : s;
}

// ---------------------------------------------------------------------------
// Get Inbound Shipment List
// ---------------------------------------------------------------------------
const CARRIER_NAMES: Readonly<Record<number, string>> = {
  101: "DHL",
  102: "FedEx",
  103: "UPS",
  104: "USPS",
  105: "Newegg Partnered Carrier (UPS)",
};

function parseAddress(row: unknown): SbnAddress {
  return {
    address1: text(getField(row, "ShipToAddress1")),
    address2: text(getField(row, "ShipToAddress2")),
    city: text(getField(row, "ShipToCityName")),
    state: text(getField(row, "ShipToStateCode")),
    zip: text(getField(row, "ShipToZipCode")),
    country: text(getField(row, "ShipToCountryCode")),
  };
}

function parsePackage(row: unknown): SbnShipmentPackage {
  return {
    trackingNumber: text(getField(row, "TrackingNumber")),
    weight: asNumber(getField(row, "PackageWeight")),
    length: asNumber(getField(row, "PackageLength")),
    height: asNumber(getField(row, "PackageHeight")),
    width: asNumber(getField(row, "PackageWidth")),
  };
}

function parseItem(row: unknown): SbnShipmentItem {
  return {
    sellerPartNumber: text(getField(row, "SellerPartNumber")),
    quantity: asNumber(getField(row, "Quantity")),
    numberOfPackages: asNumber(getField(row, "NumberofPackage")),
  };
}

function parseShipment(row: unknown): SbnShipment | undefined {
  const shipmentId = text(getField(row, "ShipmentID"));
  if (shipmentId === undefined) return undefined;
  const methodCode = asNumber(getField(row, "ShippingMethodCode"));
  const carrierCode = asNumber(getField(row, "ShippingCarrierCode"));
  let packages = listItems(getField(row, "PackageList"), "Package").map(parsePackage);
  // The field table documents the package fields flat on the shipment; the samples nest them.
  if (packages.length === 0 && text(getField(row, "TrackingNumber")) !== undefined) {
    packages = [parsePackage(row)];
  }
  return {
    shipmentId,
    status: text(getField(row, "Status")),
    createdAt: toTimestamp(text(getField(row, "CreateDate"))),
    lastEditedAt: toTimestamp(text(getField(row, "LastEditDate"))),
    shipFrom: text(getField(row, "ShipFrom")),
    shipToWarehouseCode: text(getField(row, "ShipToWarehouseCode")),
    shipTo: parseAddress(row),
    shippingMethod:
      methodCode === 1 ? "smallParcel" : methodCode === 2 ? "lessThanTruckload" : undefined,
    carrierCode,
    carrier:
      carrierCode !== undefined && CARRIER_NAMES[carrierCode] !== undefined
        ? CARRIER_NAMES[carrierCode]
        : text(getField(row, "OtherCarrierName")),
    packages,
    items: listItems(getField(row, "ItemList"), "Item").map(parseItem),
  };
}

/** Parses Get Inbound Shipment List (`ShipmentList > Shipment[]`); rows without an id are dropped. */
export function parseShipmentList(json: unknown, correlationId: string): SbnShipment[] {
  const body = unwrapSbn(json, correlationId);
  const shipments: SbnShipment[] = [];
  for (const row of listItems(getField(body, "ShipmentList"), "Shipment")) {
    const shipment = parseShipment(row);
    if (shipment !== undefined) shipments.push(shipment);
  }
  return shipments;
}

// ---------------------------------------------------------------------------
// Get Inbound Shipment Status Request
// ---------------------------------------------------------------------------
/** Parses Get Inbound Shipment Status Request (`ResponseList > ResponseInfo[]`). */
export function parseShipmentStatus(json: unknown, correlationId: string): SbnRequestStatusEntry[] {
  const body = unwrapSbn(json, correlationId);
  const entries: SbnRequestStatusEntry[] = [];
  for (const row of listItems(getField(body, "ResponseList"), "ResponseInfo")) {
    // The request spells the key `RequestID`, the response `RequestId`; accept both.
    const requestId = text(getField(row, "RequestId")) ?? text(getField(row, "RequestID"));
    if (requestId === undefined) continue;
    const actionCode = asNumber(getField(row, "ActionCode"));
    entries.push({
      requestId,
      action: actionCode === 1 ? "create" : actionCode === 2 ? "void" : undefined,
      requestedAt: toTimestamp(text(getField(row, "RequestDate"))),
      status: text(getField(row, "RequestStatus")),
      memo: text(getField(row, "Memo")),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Get Inbound Shipment Request Result
// ---------------------------------------------------------------------------
export interface ParsedShipmentResult {
  requestId?: string;
  requestedAt?: { raw: string; iso?: string };
  processedAt?: { raw: string; iso?: string };
  status?: string;
  shipmentId?: string;
  labels: SbnShipmentLabel[];
  errors: string[];
}

function parseLabel(row: unknown): SbnShipmentLabel {
  // The sample spells the key `LabelUrl`, the field table `LabelURL`; accept both. The URL itself
  // may embed credentials (like the report-file FTP URLs, §17.5), so only its host and file name
  // leave this function.
  const url = text(getField(row, "LabelUrl")) ?? text(getField(row, "LabelURL"));
  const location = url === undefined ? undefined : describeReportFile(url);
  return {
    type: text(getField(row, "LabelType")),
    host: location?.host,
    fileName: location?.fileName,
  };
}

function errorTexts(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const direct = text(entry);
    if (direct !== undefined) {
      out.push(direct);
      continue;
    }
    if (!isRecord(entry)) continue;
    const nested = getField(entry, "Error");
    if (nested !== undefined) {
      out.push(...errorTexts(nested));
      continue;
    }
    const message = text(entry.ErrorDescription) ?? text(entry.Description) ?? text(entry.Message);
    if (message !== undefined) out.push(message);
  }
  return out;
}

/**
 * Parses Get Inbound Shipment Request Result. JSON nests `Shipment.Label[]`, XML wraps the labels
 * in `LabelURLList`; both are read. Label URLs are reduced to host + file name (never returned).
 */
export function parseShipmentResult(json: unknown, correlationId: string): ParsedShipmentResult {
  const body = unwrapSbn(json, correlationId);
  const shipment = getField(body, "Shipment");
  const labelSource = getField(shipment, "Label") ?? getField(shipment, "LabelURLList");
  const errors = [
    ...errorTexts(getField(body, "ErrorDescription")),
    ...errorTexts(getField(shipment, "ErrorList")),
    ...errorTexts(getField(body, "ErrorList")),
  ];
  return {
    requestId: text(getField(body, "RequestID")) ?? text(getField(body, "RequestId")),
    requestedAt: toTimestamp(text(getField(body, "RequestDate"))),
    processedAt: toTimestamp(text(getField(body, "ProcessedDate"))),
    status: text(getField(body, "RequestStatus")),
    shipmentId: text(getField(shipment, "ShipmentID")),
    labels: listItems(labelSource, "Label").map(parseLabel),
    errors: [...new Set(errors)],
  };
}

// ---------------------------------------------------------------------------
// Get Warehouse List
// ---------------------------------------------------------------------------
/** Parses Get Warehouse List (`WarehouseList > Warehouse[]`); rows without a code are dropped. */
export function parseWarehouseList(json: unknown, correlationId: string): SbnWarehouse[] {
  const body = unwrapSbn(json, correlationId);
  const warehouses: SbnWarehouse[] = [];
  for (const row of listItems(getField(body, "WarehouseList"), "Warehouse")) {
    const warehouseCode = text(getField(row, "WarehouseCode"));
    if (warehouseCode === undefined) continue;
    warehouses.push({
      warehouseCode,
      allowBulkItem: asBoolean(getField(row, "AllowBulkItem")),
      allowSmallItem: asBoolean(getField(row, "AllowSmallItem")),
      address: parseAddress(row),
    });
  }
  return warehouses;
}
