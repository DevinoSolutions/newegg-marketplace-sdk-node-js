/**
 * Order-read constants and enum-code mappings (see `newegg-api-contracts.md` §10). Newegg
 * encodes order/item status, sales channel, fulfillment, type and premier filters as small
 * integers on the wire; these pure helpers convert between those codes and the SDK's
 * normalized string unions in both directions.
 */
import type {
  OrderFulfillment,
  OrderItemStatus,
  OrderSalesChannel,
  OrderStatus,
  OrderTypeFilter,
  PremierOrderFilter,
} from "../types.js";

/** Version pin for Get Order Information (highest documented; every mapped field available). */
export const ORDER_INFO_VERSION = "315";

/** Version pin for Get Order Status (the only documented version). */
export const ORDER_STATUS_VERSION = "304";

/** Maximum `PageSize` Get Order Information accepts. */
export const ORDERS_PAGE_SIZE_MAX = 100;

/** Newegg error codes meaning "no such order for this seller" on Get Order Status. */
export const ORDER_NOT_FOUND_ERROR_CODES: ReadonlySet<string> = new Set(["SO003"]);

/** Order status wire code (0–5) → normalized union; unrecognized → `"unknown"`. */
export function orderStatusFromCode(code: number | undefined): OrderStatus {
  switch (code) {
    case 0:
      return "unshipped";
    case 1:
      return "partiallyShipped";
    case 2:
      return "shipped";
    case 3:
      return "invoiced";
    case 4:
      return "voided";
    case 5:
      return "paymentPending";
    default:
      return "unknown";
  }
}

/** Normalized order status → wire `Status` code; `"unknown"` has no code (returns `undefined`). */
export function orderStatusToCode(status: OrderStatus): number | undefined {
  switch (status) {
    case "unshipped":
      return 0;
    case "partiallyShipped":
      return 1;
    case "shipped":
      return 2;
    case "invoiced":
      return 3;
    case "voided":
      return 4;
    case "paymentPending":
      return 5;
    case "unknown":
      return undefined;
  }
}

/** Item status wire code (1/2/3) → normalized union. A DIFFERENT scale from order status. */
export function orderItemStatusFromCode(code: number | undefined): OrderItemStatus {
  switch (code) {
    case 1:
      return "unshipped";
    case 2:
      return "shipped";
    case 3:
      return "cancelled";
    default:
      return "unknown";
  }
}

/** Sales-channel wire code (0–3) → normalized union. */
export function orderSalesChannelFromCode(code: number | undefined): OrderSalesChannel {
  switch (code) {
    case 0:
      return "newegg";
    case 1:
      return "multiChannel";
    case 2:
      return "replacement";
    case 3:
      return "nws";
    default:
      return "unknown";
  }
}

/** Fulfillment wire code (0 seller / 1 Newegg) → normalized union; unrecognized → `undefined`. */
export function orderFulfillmentFromCode(code: number | undefined): OrderFulfillment | undefined {
  switch (code) {
    case 0:
      return "seller";
    case 1:
      return "newegg";
    default:
      return undefined;
  }
}

/** Normalized `Type` filter → wire code. */
export function orderTypeFilterToCode(type: OrderTypeFilter): number {
  switch (type) {
    case "all":
      return 0;
    case "sbn":
      return 1;
    case "sbs":
      return 2;
    case "multiChannel":
      return 3;
    case "nws":
      return 4;
  }
}

/** Normalized `PremierOrder` filter → wire code. */
export function premierOrderFilterToCode(filter: PremierOrderFilter): number {
  switch (filter) {
    case "all":
      return 0;
    case "premierOnly":
      return 1;
    case "noPremier":
      return 2;
  }
}
