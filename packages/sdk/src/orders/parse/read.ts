/**
 * Pure request builders and tolerant response parsers for the order-read endpoints. Kept
 * free of transport concerns so they can be unit-tested against raw wire fixtures. Every
 * reader tolerates Newegg's quirks (numbers as strings, booleans as "0"/"1"/"true", any
 * single-element list as an object instead of an array) via the shared wire helpers.
 */
import type {
  Order,
  OrderAmounts,
  OrderCustomer,
  OrderFulfillment,
  OrderItem,
  OrderPackage,
  OrderSalesChannel,
  OrderStatus,
  ShipToAddress,
} from "../../types.js";
import { toTimestamp } from "../../platform/dates.js";
import { asBoolean, asNumber, asString, getField } from "../../schemas/wire.js";
import {
  orderFulfillmentFromCode,
  orderItemStatusFromCode,
  orderSalesChannelFromCode,
  orderStatusFromCode,
} from "../constants.js";
import { listItems, type OrdersPageInfo } from "./shared.js";

/** Normalized Get Order Status result (before the API attaches marketplace/correlation). */
interface ParsedOrderStatus {
  orderNumber: string;
  status: OrderStatus;
  statusName?: string;
  downloaded?: boolean;
  salesChannel?: OrderSalesChannel;
  fulfillment?: OrderFulfillment;
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
