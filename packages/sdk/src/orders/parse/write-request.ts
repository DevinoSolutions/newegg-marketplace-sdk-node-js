import type {
  CancelOrderInput,
  ConfirmOrdersInput,
  RemoveOrderItemsInput,
  ShipOrderInput,
} from "../../types.js";
import type { NeweggValidationIssue } from "../../errors/index.js";
import { NeweggValidationError } from "../../errors/index.js";
import {
  KILL_ITEM_OPERATION,
  ORDER_ACTION_CANCEL,
  ORDER_ACTION_SHIP,
  ORDER_CONFIRMATION_OPERATION,
  cancelReasonToCode,
} from "../constants.js";

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
