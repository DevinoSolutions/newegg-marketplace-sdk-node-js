/**
 * Canonical tool names. Kept in a leaf module so both the tool definitions and the public
 * `index.ts` can import them without any import cycle.
 */
export const TOOL_NAMES = {
  inventoryGet: "newegg_inventory_get",
  inventoryPreviewUpdate: "newegg_inventory_preview_update",
  inventoryApplyUpdate: "newegg_inventory_apply_update",
  pricingGet: "newegg_pricing_get",
  pricingPreviewUpdate: "newegg_pricing_preview_update",
  pricingApplyUpdate: "newegg_pricing_apply_update",
  feedStatus: "newegg_feed_status",
  feedResult: "newegg_feed_result",
  serviceStatus: "newegg_service_status",
  ordersList: "newegg_orders_list",
  ordersGet: "newegg_orders_get",
  ordersGetStatus: "newegg_orders_get_status",
  rmaList: "newegg_rma_list",
  rmaGet: "newegg_rma_get",
  refundList: "newegg_refund_list",
  refundStatus: "newegg_refund_status",
  catalogResolve: "newegg_catalog_resolve",
  catalogLookupStatus: "newegg_catalog_lookup_status",
  reportsSettlementSummary: "newegg_reports_settlement_summary",
  reportsSettlementTransactions: "newegg_reports_settlement_transactions",
  reportsDailyInventory: "newegg_reports_daily_inventory",
  reportsDailyPrice: "newegg_reports_daily_price",
  reportsStatus: "newegg_reports_status",
  listingPreviewCreate: "newegg_listing_preview_create",
  listingApplyCreate: "newegg_listing_apply_create",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
