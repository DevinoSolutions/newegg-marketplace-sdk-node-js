/**
 * Pure request builders and tolerant response parsers for the courtesy-refund reads (contracts
 * §18.2 / §18.3). Free of transport concerns; every reader tolerates object-or-array lists, string
 * numbers and the optional `NeweggAPIResponse` wrapper. The docs vary the element casing
 * (`CourtesyrefundInfo` vs `CourtesyRefundInfo`), so both are read.
 */
import type {
  CourtesyRefund,
  CourtesyRefundRequestStatus,
  ListCourtesyRefundRequestsInput,
  ListCourtesyRefundsInput,
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
  COURTESY_REFUND_INFO_OPERATION_TYPE,
  COURTESY_REFUND_STATUS_MAX_COUNT,
  COURTESY_REFUND_STATUS_OPERATION_TYPE,
  courtesyKeywordTypeToCode,
  courtesyReasonFromCode,
  courtesyRequestStateFromWire,
  courtesyRequestStateToWire,
  courtesyStatusFromWire,
  courtesyStatusToFilterCode,
} from "./constants.js";

function parseCourtesyRefund(raw: unknown): CourtesyRefund {
  const g = (key: string): unknown => getField(raw, key);
  const reasonCode = asNumber(g("ReasonCode"));
  return {
    courtesyRefundId: asString(g("CourtesyRefundID")) ?? "",
    orderNumber: asString(g("SONumber")),
    orderAmount: asNumber(g("SOAmount")),
    invoiceNumber: asString(g("InvoiceNumber")),
    refundAmount: asNumber(g("RefundAmount")),
    reason: courtesyReasonFromCode(reasonCode),
    reasonCode,
    reasonDescription: asString(g("Reason")),
    noteToCustomer: asString(g("NoteToCustomer")),
    status: courtesyStatusFromWire(asString(g("Status"))),
    issuedByNewegg: asBoolean(g("IsNeweggRefund")),
    createdBy: asString(g("InUserName")),
    createdDate: toTimestamp(asString(g("InDate"))),
    editedBy: asString(g("EditUserName")),
    editedDate: toTimestamp(asString(g("EditDate"))),
  };
}

/** Parses a Get Courtesy Refund Information response. */
export function parseCourtesyRefundsResponse(
  json: unknown,
  correlationId: string,
): { refunds: CourtesyRefund[]; page: ServicePageInfo } {
  const { body } = unwrapResponse(json, correlationId);
  const refunds = listItems(
    getField(body, "CourtesyRefundInfoList"),
    "CourtesyrefundInfo",
    "CourtesyRefundInfo",
  ).map(parseCourtesyRefund);
  return { refunds, page: parsePageInfo(body) };
}

/** Parses a Get Courtesy Refund Request Status response (`ResponseList > ResponseInfo`). */
export function parseCourtesyRefundRequestsResponse(
  json: unknown,
  correlationId: string,
): CourtesyRefundRequestStatus[] {
  const { body } = unwrapResponse(json, correlationId);
  return listItems(getField(body, "ResponseList"), "ResponseInfo").map((info) => {
    const g = (key: string): unknown => getField(info, key);
    const result = g("Result");
    const refundRaw = listItems(result, "CourtesyRefundInfo", "CourtesyrefundInfo")[0];
    const stateRaw = asString(g("RequestStatus"));
    return {
      requestId: asString(g("RequestId")) ?? asString(g("RequestID")) ?? "",
      requestType: asString(g("RequestType")),
      requestDate: toTimestamp(asString(g("RequestDate"))),
      state: courtesyRequestStateFromWire(stateRaw),
      stateRaw,
      processMemo: asString(g("ProcessMemo")),
      refund: refundRaw !== undefined ? parseCourtesyRefund(refundRaw) : undefined,
    };
  });
}

/**
 * Builds the Get Courtesy Refund Information body. Validates paging/dates/keyword and emits only
 * the criteria the caller set. Wire values are strings, as in the documented JSON sample.
 */
export function buildCourtesyRefundInfoRequest(input: ListCourtesyRefundsInput): {
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
  throwIfInvalid("Invalid list-courtesy-refunds input.", issues);

  const criteria: Record<string, unknown> = {
    PageInfo: { PageIndex: String(pageIndex), PageSize: String(pageSize) },
  };
  if (input.keyword !== undefined) {
    criteria.KeywordsType = String(courtesyKeywordTypeToCode(input.keyword.type));
    criteria.KeywordsValue = input.keyword.value.trim();
  }
  if (input.status !== undefined)
    criteria.Status = String(courtesyStatusToFilterCode(input.status));
  if (input.dateFrom !== undefined) criteria.DateFrom = renderCriteriaDate(input.dateFrom);
  if (input.dateTo !== undefined) criteria.DateTo = renderCriteriaDate(input.dateTo);
  return {
    body: { OperationType: COURTESY_REFUND_INFO_OPERATION_TYPE, RequestBody: criteria },
    pageIndex,
    pageSize,
  };
}

/** Builds the Get Courtesy Refund Request Status body (`RequestBody.GetRequestStatus`). */
export function buildCourtesyRefundStatusRequest(input: ListCourtesyRefundRequestsInput): unknown {
  const issues: NeweggValidationIssue[] = [];
  checkCriteriaDate(input.dateFrom, "dateFrom", issues);
  checkCriteriaDate(input.dateTo, "dateTo", issues);
  if (input.requestIds !== undefined) {
    if (input.requestIds.length === 0) {
      issues.push({ path: "requestIds", message: "must contain at least one id when set" });
    }
    input.requestIds.forEach((id, i) => {
      if (typeof id !== "string" || id.trim() === "") {
        issues.push({ path: `requestIds[${i}]`, message: "must be a non-empty string" });
      }
    });
  }
  const maxCount = input.maxCount ?? COURTESY_REFUND_STATUS_MAX_COUNT;
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > COURTESY_REFUND_STATUS_MAX_COUNT) {
    issues.push({
      path: "maxCount",
      message: `must be an integer between 1 and ${COURTESY_REFUND_STATUS_MAX_COUNT}`,
    });
  }
  throwIfInvalid("Invalid courtesy-refund-request-status input.", issues);

  const criteria: Record<string, unknown> = {};
  if (input.requestIds !== undefined) {
    criteria.RequestIDList = { RequestID: input.requestIds.map((id) => id.trim()) };
  }
  criteria.MaxCount = String(maxCount);
  criteria.RequestStatus =
    input.status !== undefined ? courtesyRequestStateToWire(input.status) : "ALL";
  if (input.dateFrom !== undefined) criteria.RequestDateFrom = renderCriteriaDate(input.dateFrom);
  if (input.dateTo !== undefined) criteria.RequestDateTo = renderCriteriaDate(input.dateTo);
  return {
    OperationType: COURTESY_REFUND_STATUS_OPERATION_TYPE,
    RequestBody: { GetRequestStatus: criteria },
  };
}
