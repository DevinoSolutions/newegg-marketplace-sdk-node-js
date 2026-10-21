/**
 * Pure request builders and tolerant response parsers for the order-read endpoints. Kept
 * free of transport concerns so they can be unit-tested against raw wire fixtures. Every
 * reader tolerates Newegg's quirks (numbers as strings, booleans as "0"/"1"/"true", any
 * single-element list as an object instead of an array) via the shared wire helpers.
 */
import type {
  AdditionalOrderInfo,
  AdditionalOrderRecipient,
  CancelOrderInput,
  CancelOrderOutcome,
  ConfirmOrdersInput,
  ListAdditionalOrderInfoInput,
  ListOrdersInput,
  Order,
  OrderAmounts,
  OrderCustomer,
  OrderFulfillment,
  OrderItem,
  OrderPackage,
  OrderSalesChannel,
  OrderStatus,
  RemoveOrderItemsInput,
  ShipOrderInput,
  ShipPackageResult,
  ShipToAddress,
} from "../types.js";
import type { NeweggValidationIssue } from "../errors/index.js";
import { NeweggValidationError } from "../errors/index.js";
import { formatPacificWallClock, toTimestamp } from "../platform/dates.js";
import { asArray, asBoolean, asNumber, asString, getField } from "../schemas/wire.js";
import {
  KILL_ITEM_OPERATION,
  ORDER_ACTION_CANCEL,
  ORDER_ACTION_SHIP,
  ORDER_ADDITIONAL_INFO_OPERATION,
  ORDER_CONFIRMATION_OPERATION,
  ORDERS_PAGE_SIZE_MAX,
  cancelOutcomeFromLabel,
  cancelReasonToCode,
  orderFulfillmentFromCode,
  orderItemStatusFromCode,
  orderSalesChannelFromCode,
  orderStatusFromCode,
  orderStatusFromLabel,
  orderStatusToCode,
  orderTypeFilterToCode,
  premierOrderFilterToCode,
} from "./constants.js";

/** Paging envelope extracted from a Get Order Information response. */
interface OrdersPageInfo {
  totalCount: number;
  totalPageCount: number;
  pageIndex: number;
  pageSize: number;
}

/** Normalized Get Order Status result (before the API attaches marketplace/correlation). */
interface ParsedOrderStatus {
  orderNumber: string;
  status: OrderStatus;
  statusName?: string;
  downloaded?: boolean;
  salesChannel?: OrderSalesChannel;
  fulfillment?: OrderFulfillment;
}

/**
 * Reads a Newegg list that may be a bare JSON array, an XML-style `{ Inner: [...] }` wrapper,
 * a single wrapped object, or a single bare object. Missing → empty array. Blank entries are
 * dropped: Newegg sends an empty list as `""` (seen live on servicemgmt, 2026-10-10), which
 * must not become a phantom order. Scalars stay, since some lists hold bare order numbers.
 */
function listItems(container: unknown, innerKey: string): unknown[] {
  const rows = (value: unknown): unknown[] => asArray(value).filter(isPresent);
  if (Array.isArray(container)) return container.filter(isPresent);
  const inner = getField(container, innerKey);
  if (inner !== undefined) return rows(inner);
  return rows(container);
}

function isPresent(value: unknown): boolean {
  return (
    value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "")
  );
}

function anyDefined(...values: unknown[]): boolean {
  return values.some((value) => value !== undefined);
}

function parseShipTo(order: unknown): ShipToAddress | undefined {
  const g = (key: string): unknown => getField(order, key);
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
  return anyDefined(
    address.firstName,
    address.lastName,
    address.company,
    address.address1,
    address.address2,
    address.city,
    address.stateCode,
    address.zipCode,
    address.countryCode,
  )
    ? address
    : undefined;
}

function parseCustomer(order: unknown): OrderCustomer | undefined {
  const g = (key: string): unknown => getField(order, key);
  const customer: OrderCustomer = {
    name: asString(g("CustomerName")),
    phoneNumber: asString(g("CustomerPhoneNumber")),
    emailAddress: asString(g("CustomerEmailAddress")),
    shipTo: parseShipTo(order),
  };
  return anyDefined(customer.name, customer.phoneNumber, customer.emailAddress, customer.shipTo)
    ? customer
    : undefined;
}

function parseAmounts(order: unknown): OrderAmounts {
  const g = (key: string): unknown => getField(order, key);
  return {
    itemAmount: asNumber(g("OrderItemAmount")),
    shippingAmount: asNumber(g("ShippingAmount")),
    discountAmount: asNumber(g("DiscountAmount")),
    refundAmount: asNumber(g("RefundAmount")),
    salesTax: asNumber(g("SalesTax")),
    vatTotal: asNumber(g("VATTotal")),
    dutyTotal: asNumber(g("DutyTotal")),
    recyclingFee: asNumber(g("RecyclingFeeAmount")),
    gstOrHstAmount: asNumber(g("GSTorHSTAmount")),
    pstOrQstAmount: asNumber(g("PSTorQSTAmount")),
    ehfAmount: asNumber(g("EHFAmount")),
    total: asNumber(g("OrderTotalAmount")),
  };
}

function parseOrderItem(raw: unknown): OrderItem {
  const g = (key: string): unknown => getField(raw, key);
  return {
    sellerPartNumber: asString(g("SellerPartNumber")),
    neweggItemNumber: asString(g("NeweggItemNumber")),
    mfrPartNumber: asString(g("MfrPartNumber")),
    upc: asString(g("UPCCode")),
    description: asString(g("Description")),
    orderedQty: asNumber(g("OrderedQty")),
    shippedQty: asNumber(g("ShippedQty")),
    unitPrice: asNumber(g("UnitPrice")),
    extendedUnitPrice: asNumber(g("ExtendUnitPrice")),
    extendedShippingCharge: asNumber(g("ExtendShippingCharge")),
    status: orderItemStatusFromCode(asNumber(g("Status"))),
    statusDescription: asString(g("StatusDescription")),
    buyerRequestedCancel: asBoolean(g("BuyerRequestedCancel")),
  };
}

function parseOrderPackage(raw: unknown): OrderPackage {
  const g = (key: string): unknown => getField(raw, key);
  const lines = listItems(g("ItemInfoList"), "ItemInfo").map((line) => ({
    sellerPartNumber: asString(getField(line, "SellerPartNumber")),
    mfrPartNumber: asString(getField(line, "MfrPartNumber")),
    shippedQty: asNumber(getField(line, "ShippedQty")),
  }));
  return {
    ...(lines.length > 0 ? { items: lines } : {}),
    shipCarrier: asString(g("ShipCarrier")),
    shipService: asString(g("ShipService")),
    trackingNumber: asString(g("TrackingNumber")),
    shipDate: toTimestamp(asString(g("ShipDate"))),
    sellerPartNumber: asString(g("SellerPartNumber")),
    mfrPartNumber: asString(g("MfrPartNumber")),
    shippedQty: asNumber(g("ShippedQty")),
    memo: asString(g("Memo")),
  };
}

/** Maps one `OrderInfo` node; also used for the Order List report rows (contracts §17.6). */
export function parseOrder(raw: unknown): Order {
  const g = (key: string): unknown => getField(raw, key);
  return {
    orderNumber: asString(g("OrderNumber")) ?? "",
    sellerOrderNumber: asString(g("SellerOrderNumber")),
    invoiceNumber: asString(g("InvoiceNumber")),
    status: orderStatusFromCode(asNumber(g("OrderStatus"))),
    statusDescription: asString(g("OrderStatusDescription")),
    downloaded: asBoolean(g("OrderDownloaded")),
    orderDate: toTimestamp(asString(g("OrderDate"))),
    autoVoidTime: toTimestamp(asString(g("AutoVoidTime"))),
    isAutoVoid: asBoolean(g("IsAutoVoid")),
    salesChannel: orderSalesChannelFromCode(asNumber(g("SalesChannel"))),
    fulfillment: orderFulfillmentFromCode(asNumber(g("FulfillmentOption"))),
    currencyCode: asString(g("CurrencyCode")),
    customer: parseCustomer(raw),
    shipService: asString(g("ShipService")),
    signatureRequired: asBoolean(g("SignatureRequired")),
    onTimeShipDueDate: toTimestamp(asString(g("OnTimeShipDueDate"))),
    deliverDueDate: toTimestamp(asString(g("DeliverDueDate"))),
    amounts: parseAmounts(raw),
    quantity: asNumber(g("OrderQty")),
    items: listItems(g("ItemInfoList"), "ItemInfo").map(parseOrderItem),
    packages: listItems(g("PackageInfoList"), "PackageInfo").map(parseOrderPackage),
  };
}

/** Parses a Get Order Information response (tolerating the optional `NeweggAPIResponse` wrapper). */
export function parseOrdersResponse(json: unknown): { orders: Order[]; page: OrdersPageInfo } {
  const root = getField(json, "NeweggAPIResponse") ?? json;
  const body = getField(root, "ResponseBody") ?? root;
  const pageInfo = getField(body, "PageInfo");
  // Missing paging fields default to 0 (an "absent" sentinel — PageIndex/PageSize are never
  // legitimately 0) so the caller can fall back to the requested paging.
  const page: OrdersPageInfo = {
    totalCount: asNumber(getField(pageInfo, "TotalCount")) ?? 0,
    totalPageCount: asNumber(getField(pageInfo, "TotalPageCount")) ?? 0,
    pageIndex: asNumber(getField(pageInfo, "PageIndex")) ?? 0,
    pageSize: asNumber(getField(pageInfo, "PageSize")) ?? 0,
  };
  const orders = listItems(getField(body, "OrderInfoList"), "OrderInfo").map(parseOrder);
  return { orders, page };
}

/** Parses a Get Order Status response (flat object; tolerates the `QueryOrderStatusInfo` root). */
export function parseOrderStatus(json: unknown): ParsedOrderStatus {
  const root = getField(json, "QueryOrderStatusInfo") ?? json;
  const g = (key: string): unknown => getField(root, key);
  return {
    orderNumber: asString(g("OrderNumber")) ?? "",
    status: orderStatusFromCode(asNumber(g("OrderStatusCode"))),
    statusName: asString(g("OrderStatusName")),
    downloaded: asBoolean(g("OrderDownloaded")),
    salesChannel: orderSalesChannelFromCode(asNumber(g("SalesChannel"))),
    fulfillment: orderFulfillmentFromCode(asNumber(g("FulfillmentOption"))),
  };
}

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
  if (input.isInternal !== undefined && typeof input.isInternal !== "boolean") {
    issues.push({ path: "isInternal", message: "must be a boolean" });
  }
  if (input.lastUpdatedAfter !== undefined) {
    const value: unknown = input.lastUpdatedAfter;
    const valid =
      value instanceof Date
        ? !Number.isNaN(value.getTime())
        : typeof value === "string" && value.trim() !== "";
    if (!valid) {
      issues.push({
        path: "lastUpdatedAfter",
        message: "must be a valid Date or a non-empty string",
      });
    }
  }
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
  if (input.status) {
    const code = orderStatusToCode(input.status);
    if (code !== undefined) criteria.Status = code;
  }
  if (input.type) criteria.Type = orderTypeFilterToCode(input.type);
  // false = exclude already-downloaded (OrderDownloaded=1); default includes all.
  if (input.includeDownloaded === false) criteria.OrderDownloaded = 1;
  if (input.premierOrder) criteria.PremierOrder = premierOrderFilterToCode(input.premierOrder);
  if (input.dateFrom !== undefined) criteria.OrderDateFrom = renderOrderDate(input.dateFrom);
  if (input.dateTo !== undefined) criteria.OrderDateTo = renderOrderDate(input.dateTo);
  if (input.countryCode) criteria.CountryCode = input.countryCode;
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

function renderOrderDate(value: Date | string): string {
  return typeof value === "string" ? value : formatPacificWallClock(value);
}

// ── Order writes (§11) ──────────────────────────────────────────────────────────────────────

/** Validates and stringifies an order number (Newegg requires a positive integer 1–2147483647). */
function normalizeOrderNumber(
  value: string | number,
  issues: NeweggValidationIssue[],
  path = "orderNumber",
): string {
  const str = String(value).trim();
  if (!/^\d+$/.test(str) || Number(str) < 1) {
    issues.push({ path, message: "must be a positive integer (1–2147483647)" });
  }
  return str;
}

/** Ship Order request (`Action` = 2). `sellerId` fills the shipment header (must match the URL). */
export function buildShipRequest(
  input: ShipOrderInput,
  sellerId: string,
): { body: unknown; orderNumber: string } {
  const issues: NeweggValidationIssue[] = [];
  const orderNumber = normalizeOrderNumber(input.orderNumber, issues);
  if (!input.packages || input.packages.length === 0) {
    issues.push({ path: "packages", message: "at least one package is required" });
  }
  const packages = (input.packages ?? []).map((pkg, p) => {
    if (!pkg.trackingNumber) {
      issues.push({ path: `packages[${p}].trackingNumber`, message: "is required" });
    }
    if (!pkg.shipCarrier)
      issues.push({ path: `packages[${p}].shipCarrier`, message: "is required" });
    if (!pkg.shipService)
      issues.push({ path: `packages[${p}].shipService`, message: "is required" });
    if (!pkg.items || pkg.items.length === 0) {
      issues.push({ path: `packages[${p}].items`, message: "at least one item is required" });
    }
    const items = (pkg.items ?? []).map((it, i) => {
      if (!it.sellerPartNumber) {
        issues.push({
          path: `packages[${p}].items[${i}].sellerPartNumber`,
          message: "is required",
        });
      }
      if (!Number.isInteger(it.shippedQty) || it.shippedQty < 1) {
        issues.push({
          path: `packages[${p}].items[${i}].shippedQty`,
          message: "must be an integer >= 1",
        });
      }
      const item: Record<string, unknown> = {
        SellerPartNumber: it.sellerPartNumber,
        ShippedQty: String(it.shippedQty),
      };
      if (it.neweggItemNumber) item.NeweggItemNumber = it.neweggItemNumber;
      return item;
    });
    return {
      TrackingNumber: pkg.trackingNumber,
      ShipCarrier: pkg.shipCarrier,
      ShipService: pkg.shipService,
      ItemList: { Item: items },
    };
  });
  if (issues.length > 0) throw new NeweggValidationError("Invalid ship-order input.", issues);
  const body = {
    Action: ORDER_ACTION_SHIP,
    Value: {
      Shipment: {
        Header: { SellerID: sellerId, SONumber: orderNumber },
        PackageList: { Package: packages },
      },
    },
  };
  return { body, orderNumber };
}

/** Cancel Order request (`Action` = 1). The reason maps to a Newegg reason code. */
export function buildCancelRequest(input: CancelOrderInput): {
  body: unknown;
  orderNumber: string;
} {
  const issues: NeweggValidationIssue[] = [];
  const orderNumber = normalizeOrderNumber(input.orderNumber, issues);
  if (issues.length > 0) throw new NeweggValidationError("Invalid cancel-order input.", issues);
  const body = { Action: ORDER_ACTION_CANCEL, Value: cancelReasonToCode(input.reason) };
  return { body, orderNumber };
}

/** Order Confirmation request (mark-downloaded). `IssueUser` sits at the request-envelope top. */
export function buildConfirmRequest(input: ConfirmOrdersInput): { body: unknown } {
  const issues: NeweggValidationIssue[] = [];
  if (!input.orderNumbers || input.orderNumbers.length === 0) {
    issues.push({ path: "orderNumbers", message: "at least one order number is required" });
  }
  const orderNumbers = (input.orderNumbers ?? []).map((value, i) =>
    normalizeOrderNumber(value, issues, `orderNumbers[${i}]`),
  );
  if (issues.length > 0) throw new NeweggValidationError("Invalid confirm-orders input.", issues);
  const body: Record<string, unknown> = {
    OperationType: ORDER_CONFIRMATION_OPERATION,
    RequestBody: { DownloadedOrderList: { OrderNumber: orderNumbers } },
  };
  // IssueUser placement is per Newegg's request-envelope convention (the sample omits it). ASSUMPTION.
  if (input.issueUser) body.IssueUser = input.issueUser;
  return { body };
}

/** Remove Item (KillItem) request. `Memo`/`IssueUser` placement follows Newegg convention (ASSUMPTION). */
export function buildRemoveItemsRequest(input: RemoveOrderItemsInput): {
  body: unknown;
  orderNumber: string;
} {
  const issues: NeweggValidationIssue[] = [];
  const orderNumber = normalizeOrderNumber(input.orderNumber, issues);
  if (!input.sellerPartNumbers || input.sellerPartNumbers.length === 0) {
    issues.push({
      path: "sellerPartNumbers",
      message: "at least one seller part number is required",
    });
  }
  const seen = new Set<string>();
  (input.sellerPartNumbers ?? []).forEach((spn, i) => {
    if (!spn) issues.push({ path: `sellerPartNumbers[${i}]`, message: "must not be empty" });
    else if (seen.has(spn)) {
      issues.push({ path: `sellerPartNumbers[${i}]`, message: `duplicate '${spn}'` });
    } else seen.add(spn);
  });
  if (issues.length > 0) throw new NeweggValidationError("Invalid remove-items input.", issues);
  const requestBody: Record<string, unknown> = {
    KillItem: {
      Order: {
        ItemList: { Item: input.sellerPartNumbers.map((spn) => ({ SellerPartNumber: spn })) },
      },
    },
  };
  if (input.memo) requestBody.Memo = input.memo;
  const body: Record<string, unknown> = {
    OperationType: KILL_ITEM_OPERATION,
    RequestBody: requestBody,
  };
  if (input.issueUser) body.IssueUser = input.issueUser;
  return { body, orderNumber };
}

interface ParsedShipResponse {
  orderNumber: string;
  status: OrderStatus;
  statusLabel?: string;
  totalPackageCount: number;
  successCount: number;
  failCount: number;
  packages: ShipPackageResult[];
}

function parseShipPackageResult(raw: unknown): ShipPackageResult {
  const g = (key: string): unknown => getField(raw, key);
  return {
    trackingNumber: asString(g("TrackingNumber")),
    shipDate: toTimestamp(asString(g("ShipDate"))),
    processStatus: asBoolean(g("ProcessStatus")) ?? false,
    processResult: asString(g("ProcessResult")),
    items: listItems(g("ItemList"), "Item").map((item) => ({
      sellerPartNumber: asString(getField(item, "SellerPartNumber")),
      neweggItemNumber: asString(getField(item, "NeweggItemNumber")),
      shippedQty: asNumber(getField(item, "ShippedQty")),
    })),
  };
}

/** Parses a Ship Order response (tolerates the optional `NeweggAPIResponse` wrapper). */
export function parseShipResponse(json: unknown): ParsedShipResponse {
  const root = getField(json, "NeweggAPIResponse") ?? json;
  const summary = getField(root, "PackageProcessingSummary");
  const result = getField(root, "Result");
  const label = asString(getField(result, "OrderStatus"));
  return {
    orderNumber: asString(getField(result, "OrderNumber")) ?? "",
    status: orderStatusFromLabel(label),
    statusLabel: label,
    totalPackageCount: asNumber(getField(summary, "TotalPackageCount")) ?? 0,
    successCount: asNumber(getField(summary, "SuccessCount")) ?? 0,
    failCount: asNumber(getField(summary, "FailCount")) ?? 0,
    packages: listItems(getField(getField(result, "Shipment"), "PackageList"), "Package").map(
      parseShipPackageResult,
    ),
  };
}

interface ParsedCancelResponse {
  orderNumber: string;
  outcome: CancelOrderOutcome;
  outcomeLabel?: string;
}

/** Parses a Cancel Order response. */
export function parseCancelResponse(json: unknown): ParsedCancelResponse {
  const root = getField(json, "NeweggAPIResponse") ?? json;
  const result = getField(root, "Result") ?? root;
  const label = asString(getField(result, "OrderStatus"));
  return {
    orderNumber: asString(getField(result, "OrderNumber")) ?? "",
    outcome: cancelOutcomeFromLabel(label),
    outcomeLabel: label,
  };
}

interface ParsedConfirmResponse {
  orderNumbers: string[];
  requestDate?: { raw: string; iso?: string };
  responseDate?: { raw: string; iso?: string };
}

/** Parses an Order Confirmation response (tolerates the optional `NeweggAPIResponse` wrapper). */
export function parseConfirmResponse(json: unknown): ParsedConfirmResponse {
  const root = getField(json, "NeweggAPIResponse") ?? json;
  const body = getField(root, "ResponseBody") ?? root;
  const orderNumbers = listItems(getField(body, "DownloadedOrderList"), "OrderNumber")
    .map((value) => asString(value))
    .filter((value): value is string => value !== undefined);
  return {
    orderNumbers,
    requestDate: toTimestamp(asString(getField(body, "RequestDate"))),
    responseDate: toTimestamp(asString(getField(root, "ResponseDate"))),
  };
}

interface ParsedRemoveItemsResponse {
  orderNumber: string;
  removedSellerPartNumbers: string[];
  memo?: string;
  requestDate?: { raw: string; iso?: string };
  responseDate?: { raw: string; iso?: string };
}

/** Parses a Remove Item (KillItem) response (tolerates the optional `NeweggAPIResponse` wrapper). */
export function parseRemoveItemsResponse(json: unknown): ParsedRemoveItemsResponse {
  const root = getField(json, "NeweggAPIResponse") ?? json;
  const body = getField(root, "ResponseBody") ?? root;
  const orders = getField(body, "Orders");
  const result = getField(orders, "Result");
  const removedSellerPartNumbers = listItems(getField(result, "ItemList"), "Item")
    .map((item) => asString(getField(item, "SellerPartNumber")))
    .filter((value): value is string => value !== undefined);
  return {
    orderNumber: asString(getField(orders, "OrderNumber")) ?? "",
    removedSellerPartNumbers,
    memo: asString(getField(root, "Memo")),
    requestDate: toTimestamp(asString(getField(body, "RequestDate"))),
    responseDate: toTimestamp(asString(getField(root, "ResponseDate"))),
  };
}

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
  if (issues.length > 0) {
    throw new NeweggValidationError("Invalid list-additional-order-info input.", issues);
  }

  const criteria: Record<string, unknown> = {};
  if (input.orderNumbers && input.orderNumbers.length > 0) {
    criteria.OrderNumberList = { OrderNumber: input.orderNumbers.map((value) => String(value)) };
  }
  if (input.status) {
    const code = orderStatusToCode(input.status);
    if (code !== undefined) criteria.Status = code;
  }
  if (input.type) criteria.Type = ADDITIONAL_INFO_TYPE_CODES[input.type];
  if (input.includeDownloaded === false) criteria.OrderDownloaded = 1;
  if (input.dateFrom !== undefined) criteria.OrderDateFrom = renderOrderDate(input.dateFrom);
  if (input.dateTo !== undefined) criteria.OrderDateTo = renderOrderDate(input.dateTo);
  if (input.countryCode) criteria.CountryCode = input.countryCode;

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
