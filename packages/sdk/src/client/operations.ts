/** Operation identifiers used in rate-limit keys and structured log fields. */
export const Operation = {
  GetItem: "inventory.getItem",
  GetMany: "inventory.getMany",
  UpdateDirect: "inventory.update",
  // Get Item Price (§15) — a READ on every platform; 10,000/hr budget.
  PriceGet: "pricing.get",
  // Price WRITE (§16): own 10,000/hr budget; absolute assignments, so retry-safe (ADR 0004).
  PriceUpdate: "pricing.update",
  FeedSubmit: "feed.submit",
  FeedStatus: "feed.status",
  FeedResult: "feed.result",
  ServiceStatus: "service.status",
  // Get Order Information backs both list and get (same endpoint + 1000/hr budget).
  OrderList: "orders.list",
  // Get Order Status is a separate endpoint with its own 500/hr budget.
  OrderStatus: "orders.status",
  // Get Additional Order Information (§24): a POST read on its own endpoint; 10,000/hr budget.
  OrderAdditionalInfo: "orders.additionalInfo",
  // Order writes. Ship/Cancel PUT the shared orderstatus/orders/{n} endpoint (Action selects the
  // mutation); Confirm POSTs …/orders/confirmation; RemoveItem PUTs ordermgmt/killitem/… (§11).
  OrderShip: "orders.ship",
  OrderCancel: "orders.cancel",
  OrderConfirm: "orders.confirm",
  OrderRemoveItem: "orders.removeItems",
  // Service Management READS (contracts §18): Get RMA Information 1000/hr; Get Courtesy Refund
  // Information 30/min; Get Courtesy Refund Request Status 10,000/hr. All PUT, none mutate.
  RmaList: "rma.list",
  RefundList: "refunds.list",
  RefundRequestStatus: "refunds.requestStatus",
  // Service Management WRITES (contracts §20): NON-idempotent, so never auto-retried after dispatch
  // (ADR 0004). Submit RMA 100/hr; Edit / Receive / Reject RMA and Issue Courtesy Refund 1000/hr.
  RmaSubmit: "rma.submit",
  RmaEdit: "rma.edit",
  RmaReceive: "rma.receive",
  RmaReject: "rma.reject",
  RefundIssue: "refunds.issue",
  // Seller / category reference READS (contracts §19). Seller Status Check 500/hr; Get Industry
  // List 10,000/hr; Get Subcategory Status (both variants), Properties and Property Values
  // 100/hr each. Subcategory status shares one key across its two variants.
  SellerStatus: "reference.sellerStatus",
  IndustryList: "reference.industries",
  SubcategoryStatus: "reference.subcategories",
  SubcategoryProperties: "reference.subcategoryProperties",
  PropertyValues: "reference.propertyValues",
  // Shipped-by-Newegg inbound-shipment READS (contracts §21), Newegg.com / B2B only. Shipment List
  // and Request Result 500/hr; Request Status and Warehouse List 1,000/min. Three are PUT; none mutate.
  SbnShipmentList: "sbn.shipments",
  SbnRequestStatus: "sbn.requestStatus",
  SbnRequestResult: "sbn.requestResult",
  SbnWarehouseList: "sbn.warehouses",
  // Catalog resolution via the Item Lookup Report (reportmgmt, §12). Submit 100/hr;
  // status and result 500/hr each.
  CatalogLookupSubmit: "catalog.lookupSubmit",
  CatalogLookupStatus: "catalog.lookupStatus",
  CatalogLookupResult: "catalog.lookupResult",
  // Settlement / inventory / price reports (reportmgmt, §17): same endpoints and budgets as
  // above (submit 100/hr; status and result 500/hr each), shared across report types.
  ReportSubmit: "reports.submit",
  ReportStatus: "reports.status",
  ReportResult: "reports.result",
  // Get Volume Discount (contracts §22.1) - a READ via PUT; 100 requests/hour.
  VolumeDiscountGet: "volumeDiscounts.get",
} as const;
