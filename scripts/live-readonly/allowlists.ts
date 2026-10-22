// Allowlists, banned names and classified client surface for the AST rules (see ../live-readonly-ast.ts).

/**
 * Client namespaces that have write methods, with the ONLY methods a live file may call on them
 * (contracts §18 / §15 / §20). `<expr>.<namespace>` may appear only as `<expr>.<namespace>.<read>(`.
 * A namespace with an empty list may not be touched at all.
 */
export const WRITE_NAMESPACE_READS: Readonly<Record<string, readonly string[]>> = {
  inventory: ["getItem", "tryGetItem", "getMany"],
  pricing: ["get", "tryGet", "getMany"],
  feeds: ["getStatus", "getResult", "waitForResult"],
  orders: [
    "list",
    "get",
    "tryGet",
    "getStatus",
    "tryGetStatus",
    "listAdditionalInfo",
    "getAdditionalInfo",
    "tryGetAdditionalInfo",
  ],
  listings: [],
  rma: ["list", "get", "tryGet"],
  refunds: ["list", "get", "tryGet", "listRequests", "getRequestStatus"],
  // Get Volume Discount is a READ via PUT (contracts §22.1); update/previewUpdate submit the
  // VOLUME_DISCOUNT_DATA feed and are in WRITE_METHOD_NAMES.
  volumeDiscounts: ["get", "tryGet"],
  // Shipping Label Service (contracts §23): buying or reprinting a label spends money, and even the
  // quote needs a real order number and is unverified, so the namespace may not be touched at all.
  shippingLabels: [],
};

/**
 * Every write method on the write namespaces (and its read-only `preview*` twin). A live file may
 * not even NAME one, on any receiver: that closes aliasing through values the taint tracking cannot
 * see (a parameter, a destructured array element). check-live-readonly.ts fails when an SDK method
 * on a write namespace is in neither this set nor the namespace's read list above.
 */
export const WRITE_METHOD_NAMES: ReadonlySet<string> = new Set([
  "updateItem",
  "updateMany",
  "submitInventoryFeed",
  "ship",
  "cancel",
  "confirmDownload",
  "removeItems",
  "create",
  "previewCreate",
  "update",
  "previewUpdate",
  "submit",
  "previewSubmit",
  "edit",
  "previewEdit",
  "process",
  "previewProcess",
  "reject",
  "previewReject",
  "issue",
  "previewIssue",
  // Shipped-by-Newegg inbound-shipment writes (contracts §21) - not implemented, reserved so a
  // future method of this name forces a classification (and a live file may never name one).
  "createShipment",
  "previewCreateShipment",
  "voidShipment",
  "previewVoidShipment",
  "createInboundShipment",
  "voidInboundShipment",
  // Shipping Label Service (contracts §23): `create` / `previewCreate` are listed above. `reprint`
  // re-issues a label (treated as billable) and `estimate` is an unverified quote; none may be named.
  "reprint",
  "previewReprint",
  "estimate",
  // The create guard's local ledger check (T-6212) makes no request, but it belongs to the label
  // namespace, which a live file may not touch at all; naming it stays forbidden.
  "assertCreateNotBlocked",
  // Sponsored Ads writes (contracts §25) - not implemented, reserved so a future method of this
  // name forces a classification (and a live file may never name one). Every Sponsored Ads
  // create / add / update / change-status spends money or changes a campaign.
  "createCampaign",
  "updateCampaign",
  "changeCampaignStatus",
  "addGroup",
  "createGroup",
  "updateGroup",
  "changeGroupStatus",
  "addProduct",
  "addProducts",
  "changeProductStatus",
  "addKeyword",
  "addKeywords",
  "updateKeyword",
  "changeKeywordStatus",
  "addNegativeKeyword",
  "addNegativeKeywords",
  "addProductTargeting",
  "updateMatchTypeBid",
  "changeMatchTypeStatus",
  // Function.prototype helpers that re-bind or re-invoke a method without naming a write verb.
  "call",
  "apply",
  "bind",
]);

/**
 * Client namespaces that are read-only by contract (they create report jobs or read reference
 * data). Together with WRITE_NAMESPACE_READS this must cover every `readonly x: <Name>Api` member
 * of `NeweggClient`; clientSurfaceProblems fails when a new namespace is in neither list.
 */
export const READ_ONLY_NAMESPACE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  service: ["getStatus"],
  reference: [
    "getSellerStatus",
    "listIndustries",
    "listSubcategories",
    "listSubcategoryProperties",
    "listPropertyValues",
  ],
  // Shipped-by-Newegg inbound-shipment READS (contracts §21), three via PUT. Create / Void Inbound
  // Shipment are not in the SDK; their method names are in WRITE_METHOD_NAMES so they stay blocked.
  sbn: ["listShipments", "getRequestStatus", "getRequestResult", "listWarehouses"],
  // Sponsored Ads READS (contracts §25), all POST. The create / add / update / change-status
  // operations are not in the SDK; their method names are in WRITE_METHOD_NAMES so they stay blocked.
  ads: [
    "listCampaigns",
    "listGroups",
    "listProducts",
    "listKeywords",
    "listNegativeKeywords",
    "listMatchTypes",
    "suggestKeywords",
    "suggestCategoryTargeting",
    "suggestItemTargeting",
    "getGroupPerformance",
    "getProductPerformance",
    "getKeywordPerformance",
  ],
  catalog: ["resolve", "submitLookup", "lookupStatus", "lookupResult"],
  reports: [
    "itemBasicInfo",
    "orderList",
    "rmaList",
    "settlementSummary",
    "settlementTransactions",
    "dailyInventory",
    "dailyPrice",
    "status",
  ],
  storefront: ["getOffers"],
};

/**
 * The report interfaces that `client.reports.<report>` members are typed with, and their methods.
 * Report submission creates a report job and mutates nothing on the seller account (contracts
 * §17); a new method here must be classified before a live file may call it.
 */
export const REPORT_INTERFACE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  FileReportApi: ["submit", "status", "result", "download", "waitForRequest", "waitForResult"],
  PagedReportApi: ["submit", "status", "result", "waitForRequest", "waitForResult"],
  SettlementSummaryReportApi: ["submit", "status", "result", "waitForRequest", "waitForResult"],
  SettlementTransactionReportApi: ["submit", "status", "result", "waitForRequest", "waitForResult"],
};

export const READ_ONLY_NAMESPACES: readonly string[] = Object.keys(READ_ONLY_NAMESPACE_MEMBERS);

// Live files may import exactly these, plus the vitest API below and a few harmless node: modules.
// Importing SDK internals (e.g. `new RmaApiImpl(...)` from ../../src/rma/api.js) builds a write
// client the namespace rules cannot see. node:child_process / http / net can reach the network.
export const ALLOWED_SPECIFIERS: ReadonlySet<string> = new Set([
  "../../src/index.js",
  "./helpers.js",
]);
export const ALLOWED_NODE_MODULES: ReadonlySet<string> = new Set([
  "node:fs",
  "node:path",
  "node:url",
  "node:util",
  "node:assert",
  "node:assert/strict",
  "node:timers/promises",
]);
// `vi` is excluded on purpose: vi.importActual / vi.mock load arbitrary modules.
export const ALLOWED_VITEST_NAMES: ReadonlySet<string> = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "expect",
  "it",
  "test",
]);

// Values that can start a request or run code without going through the SDK.
export const BANNED_GLOBALS: ReadonlySet<string> = new Set([
  "fetch",
  "globalThis",
  "global",
  "eval",
  "Function",
  "Reflect",
  "Proxy",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
]);
// `.constructor` reaches Object / Function from any value (`({}).constructor.values(client)`,
// `[].constructor.constructor("return globalThis")()`), so it and `.prototype` are banned as
// properties, string keys and destructuring keys.
export const BANNED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__defineGetter__",
  "__defineSetter__",
]);

// A string-literal key (`raw["AvailableQuantity"]`) is statically resolvable, so it is judged by
// what it names: a client namespace, a write method or a reflection name is refused; any other
// literal (`raw["ShipVia"]`, `raw["UpdateDate"]`) is plain data. Any non-literal computed key is
// refused outright (`x[k]`, `x['r'+'ma']`, a template with substitutions).

export const CLIENT_SOURCES: ReadonlySet<string> = new Set([
  "makeLiveClient",
  "createNeweggClient",
  "NeweggClient",
]);
// `Object.<fn>(row)` is tolerated only for these (see isReportRowEnumeration).
export const OBJECT_ENUMERATORS: ReadonlySet<string> = new Set(["entries", "values", "keys"]);
// Array/promise methods that hand back (one of) the receiver's elements.
export const IDENTITY_METHODS: ReadonlySet<string> = new Set([
  "at",
  "find",
  "pop",
  "shift",
  "slice",
  "filter",
  "concat",
  "flat",
  "reverse",
  "sort",
  "map",
]);
