import type { CancelOrderOutcome, OrderStatus, ShipPackageResult } from "../../types.js";
import { toTimestamp } from "../../platform/dates.js";
import { asBoolean, asNumber, asString, getField } from "../../schemas/wire.js";
import { cancelOutcomeFromLabel, orderStatusFromLabel } from "../constants.js";
import { listItems } from "./shared.js";

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
