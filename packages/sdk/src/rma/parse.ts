/**
 * Pure request builder and tolerant response parser for Get RMA Information (contracts §18.1).
 * Free of transport concerns so it can be unit-tested against raw wire fixtures. Every reader
 * tolerates Newegg's quirks: numbers as strings, booleans as "0"/"1"/"true", single-element lists
 * as objects instead of arrays, and the optional `NeweggAPIResponse` wrapper.
 */
import type {
  ListRmasInput,
  Rma,
  RmaCustomer,
  RmaItem,
  RmaReturnLabel,
  ShipToAddress,
} from "../types.js";
import type { NeweggValidationIssue } from "../errors/index.js";
import { toTimestamp } from "../platform/dates.js";
import { asBoolean, asNumber, asString, getField } from "../schemas/wire.js";
import {
  checkCriteriaDate,
  listItems,
  parsePageInfo,
  renderCriteriaDate,
  resolvePaging,
  throwIfInvalid,
  unwrapResponse,
  type ServicePageInfo,
} from "../servicemgmt/shared.js";
import {
  RMA_INFO_OPERATION_TYPE,
  rmaKeywordTypeToCode,
  rmaProcessedByFromLabel,
  rmaProcessedByToCode,
  rmaReasonFromCode,
  rmaShippedByFromCode,
  rmaStatusFromCode,
  rmaStatusToCode,
  rmaTypeFromCode,
  rmaTypeToCode,
} from "./constants.js";

function anyDefined(...values: unknown[]): boolean {
  return values.some((value) => value !== undefined);
}

function parseShipTo(rma: unknown): ShipToAddress | undefined {
  const g = (key: string): unknown => getField(rma, key);
  const address: ShipToAddress = {
    firstName: asString(g("ShipToFirstName")),
    lastName: asString(g("ShipToLastName")),
    company: asString(g("ShipToCompany")),
    address1: asString(g("ShipToAddress1")),
    address2: asString(g("ShipToAddress2")),
    city: asString(g("ShipToCityName")),
    stateCode: asString(g("ShipToStateCode")),
    zipCode: asString(g("ShipToZipCode")),
    countryCode: asString(g("ShipToCountryCode")),
  };
  return anyDefined(...Object.values(address)) ? address : undefined;
}

function parseCustomer(rma: unknown): RmaCustomer | undefined {
  const g = (key: string): unknown => getField(rma, key);
  const customer: RmaCustomer = {
    name: asString(g("CustomerName")),
    phoneNumber: asString(g("CustomerPhoneNumber")),
    emailAddress: asString(g("CustomerEmailAddress")),
    shipTo: parseShipTo(rma),
  };
  return anyDefined(customer.name, customer.phoneNumber, customer.emailAddress, customer.shipTo)
    ? customer
    : undefined;
}

/**
 * The label arrives as `ReturnShippingLabel > Label` in every sample, but the field table lists the
 * four label fields flat on the RMA: read the nested form first and fall back to the flat one.
 */
function parseReturnLabel(rma: unknown): RmaReturnLabel | undefined {
  const nested = listItems(getField(rma, "ReturnShippingLabel"), "Label")[0];
  const g = (key: string): unknown => getField(nested, key) ?? getField(rma, key);
  const label: RmaReturnLabel = {
    trackingNumber: asString(g("TrackingNumber")),
    trackingUrl: asString(g("TrackingURL")),
    estimatedCost: asNumber(g("LabelEstimateCost")),
    paidBy: asString(g("PaidBy")),
  };
  return anyDefined(...Object.values(label)) ? label : undefined;
}

function parseRmaItem(raw: unknown): RmaItem {
  const g = (key: string): unknown => getField(raw, key);
  const reasonCode = asNumber(g("RMAReason"));
  return {
    sellerPartNumber: asString(g("SellerPartNumber")),
    mfrPartNumber: asString(g("MfrPartNumber")),
    neweggItemNumber: asString(g("NeweggItemNumber")),
    description: asString(g("Description")),
    unitPrice: asNumber(g("UnitPrice")),
    returnQuantity: asNumber(g("ReturnQuantity")),
    returnUnitPrice: asNumber(g("ReturnUnitPrice")),
    refundShippingPrice: asNumber(g("RefundShippingPrice")),
    rmaTotalRefund: asNumber(g("RMATotalRefund")),
    shippedBy: rmaShippedByFromCode(asNumber(g("ShippedBy"))),
    reason: rmaReasonFromCode(reasonCode),
    reasonCode,
    reasonDescription: asString(g("RMAReasonDescription")),
    unopened: asBoolean(g("UnOpen")),
    memo: asString(g("Memo")),
  };
}

/** Maps one `RMAInfo` node; also used for the RMA List report rows (contracts §17.6). */
export function parseRma(raw: unknown): Rma {
  const g = (key: string): unknown => getField(raw, key);
  return {
    rmaNumber: asString(g("RMANumber")) ?? "",
    type: rmaTypeFromCode(asNumber(g("RMAType"))),
    typeDescription: asString(g("RMATypeDescription")),
    sellerRmaNumber: asString(g("SellerRMANumber")),
    replacementOrderNumber: asString(g("ReplacementOrderNumber")),
    issueUser: asString(g("IssueUser")),
    rmaDate: toTimestamp(asString(g("RMADate"))),
    status: rmaStatusFromCode(asNumber(g("RMAStatus"))),
    statusDescription: asString(g("RMAStatusDescription")),
    shipMethod: asNumber(g("RMAShipMethod")),
    shipMethodDescription: asString(g("RMAShipMethodDescription")),
    orderNumber: asString(g("OrderNumber")),
    orderDate: toTimestamp(asString(g("OrderDate"))),
    invoiceNumber: asString(g("InvoiceNumber")),
    orderAmount: asNumber(g("OrderAmount")),
    availableRefundAmount: asNumber(g("AvailableRefundAmount")),
    priorRefundAmount: asNumber(g("PriorRefundAmount")),
    refundGstOrHstAmount: asNumber(g("RefundGSTorHSTAmount")),
    refundPstOrQstAmount: asNumber(g("RefundPSTorQSTAmount")),
    processedBy: rmaProcessedByFromLabel(asString(g("RMAProcessedBy"))),
    receiveDate: toTimestamp(asString(g("RMAReceiveDate"))),
    note: asString(g("RMANote")),
    customer: parseCustomer(raw),
    returnLabel: parseReturnLabel(raw),
    items: listItems(g("RMATransactionList"), "RMATransaction").map(parseRmaItem),
  };
}

/** Parses a Get RMA Information response (wrapped or unwrapped; object-or-array lists). */
export function parseRmaResponse(
  json: unknown,
  correlationId: string,
): { rmas: Rma[]; page: ServicePageInfo } {
  const { body } = unwrapResponse(json, correlationId);
  const rmas = listItems(getField(body, "RMAInfoList"), "RMAInfo").map(parseRma);
  return { rmas, page: parsePageInfo(body) };
}

/**
 * Builds the Get RMA Information request body from normalized criteria. Validates paging, dates
 * and the keyword (throws {@link NeweggValidationError} rather than silently clamping) and emits
 * only the criteria the caller set. Wire values are strings, exactly as in the documented JSON
 * sample. Returns the resolved paging for result fallback.
 */
export function buildRmaInfoRequest(input: ListRmasInput): {
  body: unknown;
  pageIndex: number;
  pageSize: number;
} {
  const issues: NeweggValidationIssue[] = [];
  const { pageIndex, pageSize } = resolvePaging(input.page, input.pageSize, issues);
  checkCriteriaDate(input.dateFrom, "dateFrom", issues);
  checkCriteriaDate(input.dateTo, "dateTo", issues);
  if (input.keyword !== undefined && input.keyword.value.trim() === "") {
    issues.push({ path: "keyword.value", message: "must be a non-empty string" });
  }
  throwIfInvalid("Invalid list-RMAs input.", issues);

  const criteria: Record<string, unknown> = {
    PageInfo: { PageIndex: String(pageIndex), PageSize: String(pageSize) },
  };
  if (input.keyword !== undefined) {
    criteria.KeywordsType = String(rmaKeywordTypeToCode(input.keyword.type));
    criteria.KeywordsValue = input.keyword.value.trim();
  }
  if (input.status !== undefined) criteria.Status = String(rmaStatusToCode(input.status));
  if (input.dateFrom !== undefined) criteria.RMADateFrom = renderCriteriaDate(input.dateFrom);
  if (input.dateTo !== undefined) criteria.RMADateTo = renderCriteriaDate(input.dateTo);
  if (input.type !== undefined) criteria.RMAType = String(rmaTypeToCode(input.type));
  if (input.processedBy !== undefined) {
    criteria.ProcessedBy = String(rmaProcessedByToCode(input.processedBy));
  }
  return {
    body: { OperationType: RMA_INFO_OPERATION_TYPE, RequestBody: criteria },
    pageIndex,
    pageSize,
  };
}
