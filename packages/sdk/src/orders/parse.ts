/**
 * Pure request builders and tolerant response parsers for the order-read endpoints. Kept
 * free of transport concerns so they can be unit-tested against raw wire fixtures. Every
 * reader tolerates Newegg's quirks (numbers as strings, booleans as "0"/"1"/"true", any
 * single-element list as an object instead of an array) via the shared wire helpers.
 */
export { parseOrder, parseOrderStatus, parseOrdersResponse } from "./parse/read.js";
export { buildOrderInfoRequest } from "./parse/list-request.js";
export {
  buildCancelRequest,
  buildConfirmRequest,
  buildRemoveItemsRequest,
  buildShipRequest,
} from "./parse/write-request.js";
export {
  parseCancelResponse,
  parseConfirmResponse,
  parseRemoveItemsResponse,
  parseShipResponse,
} from "./parse/write-response.js";
export {
  buildAdditionalOrderInfoRequest,
  parseAdditionalOrderInfoResponse,
} from "./parse/additional-info.js";
