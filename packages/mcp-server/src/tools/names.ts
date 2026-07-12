/**
 * Canonical tool names. Kept in a leaf module so both the tool definitions and the public
 * `index.ts` can import them without any import cycle.
 */
export const TOOL_NAMES = {
  inventoryGet: "newegg_inventory_get",
  inventoryPreviewUpdate: "newegg_inventory_preview_update",
  inventoryApplyUpdate: "newegg_inventory_apply_update",
  feedStatus: "newegg_feed_status",
  feedResult: "newegg_feed_result",
  serviceStatus: "newegg_service_status",
  ordersList: "newegg_orders_list",
  ordersGet: "newegg_orders_get",
  ordersGetStatus: "newegg_orders_get_status",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
