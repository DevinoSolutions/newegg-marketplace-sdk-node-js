import type {
  AdditionalOrderInfo,
  AdditionalOrderRecipient,
  ListAdditionalOrderInfoInput,
} from "../../types.js";
import type { NeweggValidationIssue } from "../../errors/index.js";
import { NeweggValidationError } from "../../errors/index.js";
import { asNumber, asString, getField } from "../../schemas/wire.js";
import { ORDER_ADDITIONAL_INFO_OPERATION, ORDERS_PAGE_SIZE_MAX } from "../constants.js";
import {
  checkCountryCodeInput,
  checkPacificDateInput,
  isKnownKey,
  listItems,
  renderOrderDate,
  statusCode,
  type OrdersPageInfo,
} from "./shared.js";

/** Get Additional Order Information reads `Status` 5 as "All", so `paymentPending` is not a filter there. */
const ADDITIONAL_INFO_STATUS_FILTERS: Record<string, true> = {
  unshipped: true,
  partiallyShipped: true,
  shipped: true,
  invoiced: true,
  voided: true,
};

// ── Additional order info (§24) ────────────────────────────────────────────────────────────

const ADDITIONAL_INFO_TYPE_CODES = { all: 0, sbn: 1, sbs: 2, nisp: 3 } as const;

/**
 * Builds the Get Additional Order Information request body (same envelope shape as Get Order
 * Information, `GetAddOrderInfoRequest`). Validates paging like {@link buildOrderInfoRequest}.
 * Note `Status` here also accepts 5 = All, so an omitted status is sent as-is (Newegg then
 * returns Unshipped); pass `status` explicitly or `orderNumbers` to target orders.
 */
export function buildAdditionalOrderInfoRequest(input: ListAdditionalOrderInfoInput): {
  body: unknown;
  pageIndex: number;
  pageSize: number;
} {
  const issues: NeweggValidationIssue[] = [];
  const pageSize = input.pageSize ?? ORDERS_PAGE_SIZE_MAX;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > ORDERS_PAGE_SIZE_MAX) {
    issues.push({
      path: "pageSize",
      message: `must be an integer between 1 and ${ORDERS_PAGE_SIZE_MAX}`,
    });
  }
  const pageIndex = input.page ?? 1;
  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    issues.push({ path: "page", message: "must be an integer >= 1" });
  }
  if (input.status !== undefined && !isKnownKey(ADDITIONAL_INFO_STATUS_FILTERS, input.status)) {
    issues.push({
      path: "status",
      message: `must be one of ${Object.keys(ADDITIONAL_INFO_STATUS_FILTERS).join(", ")}`,
    });
  }
  if (input.dateFrom !== undefined) checkPacificDateInput("dateFrom", input.dateFrom, issues);
  if (input.dateTo !== undefined) checkPacificDateInput("dateTo", input.dateTo, issues);
  checkCountryCodeInput(input.countryCode, issues);
  if (issues.length > 0) {
    throw new NeweggValidationError("Invalid list-additional-order-info input.", issues);
  }

  const criteria: Record<string, unknown> = {};
  if (input.orderNumbers && input.orderNumbers.length > 0) {
    criteria.OrderNumberList = { OrderNumber: input.orderNumbers.map((value) => String(value)) };
  }
  if (input.status !== undefined) criteria.Status = statusCode(input.status);
  if (input.type) criteria.Type = ADDITIONAL_INFO_TYPE_CODES[input.type];
  if (input.includeDownloaded === false) criteria.OrderDownloaded = 1;
  if (input.dateFrom !== undefined) criteria.OrderDateFrom = renderOrderDate(input.dateFrom);
  if (input.dateTo !== undefined) criteria.OrderDateTo = renderOrderDate(input.dateTo);
  if (input.countryCode !== undefined) criteria.CountryCode = input.countryCode;

  const body = {
    OperationType: ORDER_ADDITIONAL_INFO_OPERATION,
    RequestBody: { PageIndex: pageIndex, PageSize: pageSize, RequestCriteria: criteria },
  };
  return { body, pageIndex, pageSize };
}

/** Reads a recipient block whose keys share a prefix (`NISPOri` / `Original`). */
function parseAdditionalRecipient(
  raw: unknown,
  prefix: string,
): AdditionalOrderRecipient | undefined {
  const g = (key: string): unknown => getField(raw, `${prefix}${key}`);
  const recipient: AdditionalOrderRecipient = {
    firstName: asString(g("FirstName")),
    lastName: asString(g("LastName")),
    companyName: asString(g("CompanyName")),
    address1: asString(g("Address1")),
    address2: asString(g("Address2")),
    city: asString(g("City")),
    stateCode: asString(g("State")),
    zipCode: asString(g("ZipCode")),
    countryCode: asString(g("CountryCode")),
    phoneNumber: asString(g("PhoneNumber")),
  };
  return Object.values(recipient).some((value) => value !== undefined && value !== "")
    ? recipient
    : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function parseAdditionalOrderInfo(raw: unknown): AdditionalOrderInfo {
  const g = (key: string): unknown => getField(raw, key);
  // The recipient blocks arrive nested (`NISPOriginalInfo` / `OriginalInputInfo`) in the sample
  // response but are documented as flat prefixed fields; accept both.
  const nisp = getField(raw, "NISPOriginalInfo") ?? raw;
  const original = getField(raw, "OriginalInputInfo") ?? raw;
  const reserved = ["AddInfo1", "AddInfo2", "AddInfo3"]
    .map((key) => nonEmpty(asString(g(key))))
    .filter((value): value is string => value !== undefined);
  return {
    orderNumber: asString(g("OrderNumber")) ?? "",
    recipientIdType: nonEmpty(asString(g("RecipientIDType"))),
    recipientIdNumber: nonEmpty(asString(g("RecipientIDNumber"))),
    nispOriginal: parseAdditionalRecipient(nisp, "NISPOri"),
    originalInput: parseAdditionalRecipient(original, "Original"),
    taxDutyTypeChina: nonEmpty(asString(g("TaxDutyTypeChina"))),
    importTypeChina: nonEmpty(asString(g("ImportTypeChina"))),
    idCopyFront: nonEmpty(asString(g("IDCopyFront"))),
    idCopyBack: nonEmpty(asString(g("IDCopyBack"))),
    reserved,
  };
}

/** Parses a Get Additional Order Information response (tolerates the `NeweggAPIResponse` wrapper). */
export function parseAdditionalOrderInfoResponse(json: unknown): {
  records: AdditionalOrderInfo[];
  page: OrdersPageInfo;
} {
  const root = getField(json, "NeweggAPIResponse") ?? json;
  const body = getField(root, "ResponseBody") ?? root;
  const pageInfo = getField(body, "PageInfo");
  const page: OrdersPageInfo = {
    totalCount: asNumber(getField(pageInfo, "TotalCount")) ?? 0,
    totalPageCount: asNumber(getField(pageInfo, "TotalPageCount")) ?? 0,
    pageIndex: asNumber(getField(pageInfo, "PageIndex")) ?? 0,
    pageSize: asNumber(getField(pageInfo, "PageSize")) ?? 0,
  };
  const records = listItems(getField(body, "AddOrderInfoList"), "AddOrderInfo").map(
    parseAdditionalOrderInfo,
  );
  return { records, page };
}
