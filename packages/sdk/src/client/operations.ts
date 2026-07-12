/** Operation identifiers used in rate-limit keys and structured log fields. */
export const Operation = {
  GetItem: "inventory.getItem",
  GetMany: "inventory.getMany",
  UpdateDirect: "inventory.update",
  FeedSubmit: "feed.submit",
  FeedStatus: "feed.status",
  FeedResult: "feed.result",
  ServiceStatus: "service.status",
  // Get Order Information backs both list and get (same endpoint + 1000/hr budget).
  OrderList: "orders.list",
  // Get Order Status is a separate endpoint with its own 500/hr budget.
  OrderStatus: "orders.status",
} as const;
