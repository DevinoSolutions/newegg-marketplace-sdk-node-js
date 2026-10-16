/**
 * Wire constants of the Shipped-by-Newegg (SBN) inbound-shipment reads (contracts §21). Paths are
 * relative to the platform prefix (`""`, `b2b/`); SBN is not offered on CAN.
 */

/** Get Inbound Shipment List (PUT with a body; a READ). */
export const SBN_SHIPMENT_LIST_PATH = "sbnmgmt/inboundshipment/shipmentlist";

/** Get Inbound Shipment Status Request (PUT with a body; a READ). */
export const SBN_SHIPMENT_STATUS_PATH = "sbnmgmt/inboundshipment/shipmentstatus";

/** Get Inbound Shipment Request Result (GET; the request id is appended as a path segment). */
export const SBN_SHIPMENT_RESULT_PATH = "sbnmgmt/inboundshipment/shipmentresult";

/** Get Warehouse List (PUT with a body; a READ). */
export const SBN_WAREHOUSE_PATH = "sbnmgmt/inboundshipment/warehouse";

/** Fixed `OperationType` of Get Inbound Shipment List. */
export const SBN_SHIPMENT_LIST_OPERATION_TYPE = "GetShipmentListRequest";

/** Fixed `OperationType` of Get Inbound Shipment Status Request. */
export const SBN_SHIPMENT_STATUS_OPERATION_TYPE = "GetShipmentStatusRequest";

/** Fixed `OperationType` of Get Warehouse List. */
export const SBN_WAREHOUSE_OPERATION_TYPE = "GetWarehouseRequest";

/** Maximum `MaxCount` of Get Inbound Shipment Status Request (larger values still return 100). */
export const SBN_STATUS_MAX_COUNT = 100;
