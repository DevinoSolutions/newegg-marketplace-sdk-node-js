/**
 * Pure request builders and tolerant response parsers for the order-read endpoints. Kept
 * free of transport concerns so they can be unit-tested against raw wire fixtures. Every
 * reader tolerates Newegg's quirks (numbers as strings, booleans as "0"/"1"/"true", any
 * single-element list as an object instead of an array) via the shared wire helpers.
 */
import type {
  ListOrdersInput,
  Order,
  OrderAmounts,
  OrderCustomer,
  OrderFulfillment,
  OrderItem,
  OrderPackage,
  OrderSalesChannel,
  OrderStatus,
  ShipToAddress,
} from "../types.js";
import type { NeweggValidationIssue } from "../errors/index.js";
import { NeweggValidationError } from "../errors/index.js";
import { formatPacificWallClock, toTimestamp } from "../platform/dates.js";
import { asArray, asBoolean, asNumber, asString, getField } from "../schemas/wire.js";
import {
  ORDERS_PAGE_SIZE_MAX,
  orderFulfillmentFromCode,
  orderItemStatusFromCode,
  orderSalesChannelFromCode,
  orderStatusFromCode,
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
 * a single wrapped object, or a single bare object. Missing → empty array.
 */
function listItems(container: unknown, innerKey: string): unknown[] {
  if (Array.isArray(container)) return container;
  const inner = getField(container, innerKey);
  if (inner !== undefined) return asArray(inner);
  return asArray(container);
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
  return {
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

function parseOrder(raw: unknown): Order {
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

  const body = {
    OperationType: "GetOrderInfoRequest",
    RequestBody: { PageIndex: pageIndex, PageSize: pageSize, RequestCriteria: criteria },
  };
  return { body, pageIndex, pageSize };
}

function renderOrderDate(value: Date | string): string {
  return typeof value === "string" ? value : formatPacificWallClock(value);
}
