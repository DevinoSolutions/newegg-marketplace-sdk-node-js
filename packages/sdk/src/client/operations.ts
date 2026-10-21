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
  // Newegg Shipping Label Service (contracts §23): three POSTs, 1,000/hr each. Estimate is a quote
  // (a READ by the page's wording); Create BUYS a UPS label and ships the order; Reprint is billable.
  ShippingLabelEstimate: "shippingLabels.estimate",
  ShippingLabelCreate: "shippingLabels.create",
  ShippingLabelReprint: "shippingLabels.reprint",
  // Sponsored Ads READS (contracts §25), Newegg.com and Newegg.ca; every endpoint is a POST search/report
  // limited to 1,000 requests per hour. None mutate.
  AdsCampaigns: "ads.campaigns",
  AdsGroups: "ads.groups",
  AdsProducts: "ads.products",
  AdsKeywords: "ads.keywords",
  AdsKeywordSuggest: "ads.keywordSuggest",
  AdsNegativeKeywords: "ads.negativeKeywords",
  AdsMatchTypes: "ads.matchTypes",
  AdsTargetingCategories: "ads.targetingCategories",
  AdsTargetingItems: "ads.targetingItems",
  AdsGroupPerformance: "ads.groupPerformance",
  AdsProductPerformance: "ads.productPerformance",
  AdsKeywordPerformance: "ads.keywordPerformance",
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

/** Union of every operation identifier above. */
type OperationName = (typeof Operation)[keyof typeof Operation];

/**
 * Whether an operation only reads. The HTTP verb does not decide this (order-info is a read via
 * PUT; the US inventory URL is read-on-PUT, write-on-POST), so every operation is classified here
 * by what it does on the wire (contracts doc). Typed as a total record: adding an `Operation`
 * without classifying it fails the build.
 *
 * Report and catalog-lookup submissions are reads: they create a report job and mutate nothing on
 * the seller account (contracts §12.4, §17). The shipping label estimate is treated as a write
 * until an owner-authorized probe proves it has no side effect (contracts §23.6).
 */
const OPERATION_KIND: Record<OperationName, "read" | "write"> = {
  [Operation.GetItem]: "read",
  [Operation.GetMany]: "read",
  [Operation.UpdateDirect]: "write",
  [Operation.PriceGet]: "read",
  [Operation.PriceUpdate]: "write",
  [Operation.FeedSubmit]: "write",
  [Operation.FeedStatus]: "read",
  [Operation.FeedResult]: "read",
  [Operation.ServiceStatus]: "read",
  [Operation.OrderList]: "read",
  [Operation.OrderStatus]: "read",
  [Operation.OrderAdditionalInfo]: "read",
  [Operation.OrderShip]: "write",
  [Operation.OrderCancel]: "write",
  [Operation.OrderConfirm]: "write",
  [Operation.OrderRemoveItem]: "write",
  [Operation.RmaList]: "read",
  [Operation.RefundList]: "read",
  [Operation.RefundRequestStatus]: "read",
  [Operation.RmaSubmit]: "write",
  [Operation.RmaEdit]: "write",
  [Operation.RmaReceive]: "write",
  [Operation.RmaReject]: "write",
  [Operation.RefundIssue]: "write",
  [Operation.SellerStatus]: "read",
  [Operation.IndustryList]: "read",
  [Operation.SubcategoryStatus]: "read",
  [Operation.SubcategoryProperties]: "read",
  [Operation.PropertyValues]: "read",
  [Operation.SbnShipmentList]: "read",
  [Operation.SbnRequestStatus]: "read",
  [Operation.SbnRequestResult]: "read",
  [Operation.SbnWarehouseList]: "read",
  [Operation.ShippingLabelEstimate]: "write",
  [Operation.ShippingLabelCreate]: "write",
  [Operation.ShippingLabelReprint]: "write",
  [Operation.AdsCampaigns]: "read",
  [Operation.AdsGroups]: "read",
  [Operation.AdsProducts]: "read",
  [Operation.AdsKeywords]: "read",
  [Operation.AdsKeywordSuggest]: "read",
  [Operation.AdsNegativeKeywords]: "read",
  [Operation.AdsMatchTypes]: "read",
  [Operation.AdsTargetingCategories]: "read",
  [Operation.AdsTargetingItems]: "read",
  [Operation.AdsGroupPerformance]: "read",
  [Operation.AdsProductPerformance]: "read",
  [Operation.AdsKeywordPerformance]: "read",
  [Operation.CatalogLookupSubmit]: "read",
  [Operation.CatalogLookupStatus]: "read",
  [Operation.CatalogLookupResult]: "read",
  [Operation.ReportSubmit]: "read",
  [Operation.ReportStatus]: "read",
  [Operation.ReportResult]: "read",
  [Operation.VolumeDiscountGet]: "read",
};

/**
 * True only for an operation classified as a read. Fails closed: an unknown operation string is
 * treated as a write, so it never follows a redirect.
 */
export function isReadOperation(operation: string): boolean {
  return (OPERATION_KIND as Record<string, "read" | "write" | undefined>)[operation] === "read";
}
