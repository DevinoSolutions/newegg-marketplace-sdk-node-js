import type { ListOrdersInput } from "../../types.js";
import type { NeweggValidationIssue } from "../../errors/index.js";
import { NeweggValidationError } from "../../errors/index.js";
import {
  ORDERS_PAGE_SIZE_MAX,
  orderTypeFilterToCode,
  premierOrderFilterToCode,
} from "../constants.js";
import {
  checkCountryCodeInput,
  checkPacificDateInput,
  isKnownKey,
  renderOrderDate,
  statusCode,
} from "./shared.js";

const ORDER_TYPE_FILTERS: Record<string, true> = {
  all: true,
  sbn: true,
  sbs: true,
  multiChannel: true,
  nws: true,
};
const PREMIER_ORDER_FILTERS: Record<string, true> = {
  all: true,
  premierOnly: true,
  noPremier: true,
};

/** Concrete statuses `Status` can filter on; `"unknown"` is a read-side fallback with no wire code. */
const ORDER_STATUS_FILTERS: Record<string, true> = {
  unshipped: true,
  partiallyShipped: true,
  shipped: true,
  invoiced: true,
  voided: true,
  paymentPending: true,
};

/**
 * Builds the Get Order Information request body from normalized criteria. Validates paging
 * (throws {@link NeweggValidationError} rather than silently clamping) and emits only the
 * criteria the caller actually set. Returns the resolved paging for result fallback.
 */
export function buildOrderInfoRequest(input: ListOrdersInput): {
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
  // A defined value that is not a known filter must fail, never be dropped (that would send an
  // unfiltered request that looks filtered). Callers that bypass TypeScript can pass anything.
  if (input.status !== undefined && !isKnownKey(ORDER_STATUS_FILTERS, input.status)) {
    issues.push({
      path: "status",
      message: `must be one of ${Object.keys(ORDER_STATUS_FILTERS).join(", ")}`,
    });
  }
  if (input.type !== undefined && !isKnownKey(ORDER_TYPE_FILTERS, input.type)) {
    issues.push({
      path: "type",
      message: `must be one of ${Object.keys(ORDER_TYPE_FILTERS).join(", ")}`,
    });
  }
  if (input.premierOrder !== undefined && !isKnownKey(PREMIER_ORDER_FILTERS, input.premierOrder)) {
    issues.push({
      path: "premierOrder",
      message: `must be one of ${Object.keys(PREMIER_ORDER_FILTERS).join(", ")}`,
    });
  }
  if (input.isInternal !== undefined && typeof input.isInternal !== "boolean") {
    issues.push({ path: "isInternal", message: "must be a boolean" });
  }
  if (input.lastUpdatedAfter !== undefined) {
    checkPacificDateInput("lastUpdatedAfter", input.lastUpdatedAfter, issues);
  }
  if (input.dateFrom !== undefined) checkPacificDateInput("dateFrom", input.dateFrom, issues);
  if (input.dateTo !== undefined) checkPacificDateInput("dateTo", input.dateTo, issues);
  checkCountryCodeInput(input.countryCode, issues);
  if (issues.length > 0) {
    throw new NeweggValidationError("Invalid list-orders input.", issues);
  }

  const criteria: Record<string, unknown> = {};
  if (input.orderNumbers && input.orderNumbers.length > 0) {
    criteria.OrderNumberList = { OrderNumber: input.orderNumbers.map((value) => String(value)) };
  }
  if (input.sellerOrderNumbers && input.sellerOrderNumbers.length > 0) {
    criteria.SellerOrderNumberList = { SellerOrderNumber: [...input.sellerOrderNumbers] };
  }
  if (input.status !== undefined) criteria.Status = statusCode(input.status);
  if (input.type !== undefined) criteria.Type = orderTypeFilterToCode(input.type);
  // false = exclude already-downloaded (OrderDownloaded=1); default includes all.
  if (input.includeDownloaded === false) criteria.OrderDownloaded = 1;
  if (input.premierOrder !== undefined) {
    criteria.PremierOrder = premierOrderFilterToCode(input.premierOrder);
  }
  if (input.dateFrom !== undefined) criteria.OrderDateFrom = renderOrderDate(input.dateFrom);
  if (input.dateTo !== undefined) criteria.OrderDateTo = renderOrderDate(input.dateTo);
  if (input.countryCode !== undefined) criteria.CountryCode = input.countryCode;
  if (input.lastUpdatedAfter !== undefined) {
    criteria.LastUpdatedAfter = renderOrderDate(input.lastUpdatedAfter);
  }
  if (input.isInternal !== undefined) criteria.IsInternal = input.isInternal ? 1 : 0;

  const body = {
    OperationType: "GetOrderInfoRequest",
    RequestBody: { PageIndex: pageIndex, PageSize: pageSize, RequestCriteria: criteria },
  };
  return { body, pageIndex, pageSize };
}
