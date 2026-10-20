// Enforces the repository rule that the live test suite is READ-ONLY.
// The live tests in packages/sdk/test/live/ hit the REAL Newegg seller account;
// they must never mutate it. This guard fails CI when a live file gains a
// mutating SDK call, a raw POST, an ungated describe block, or when the guard
// itself would pass vacuously (no files found).
//
// Three layers, all of which may only get stricter: the per-line denylist below (also run on the
// comment-stripped source), the whitespace-normalised allowlist rules (live-readonly-rules.ts) and
// the AST rules (live-readonly-ast.ts: computed access, reflection, destructuring, import
// allowlist, namespace allowlist). A self-test proves each known bypass is still flagged.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PARSE_FAILURE_REASON, astViolations, clientSurfaceProblems } from "./live-readonly-ast.js";
import {
  MUST_FLAG,
  MUST_NOT_PARSE,
  MUST_PASS,
  normalizedViolations,
  withoutComments,
} from "./live-readonly-rules.js";

const root = resolve(import.meta.dirname, "..");
const liveDir = join(root, "packages", "sdk", "test", "live");

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};

// Mutating surface of the SDK + write-shaped raw traffic. If a legitimate new
// READ genuinely needs one of these tokens, change this list in the same PR and
// say why — that review moment is the point of the guard.
//
// NOTE (2026-07-16, owner-approved): catalog lookup via reportmgmt (catalog.resolve /
// submitLookup / lookupStatus / lookupResult) is classified READ — report submission
// creates a report job and mutates nothing on the seller account (contracts §12.4). It is
// therefore deliberately absent from this list; `submitfeed` and every listing/order/price
// mutation remain forbidden.
//
// NOTE (2026-10-10): the same holds for client.reports.* (settlement summary / transaction,
// daily inventory / price, contracts §17): report submission is a job-creating READ. The live
// reports test asserts shapes only and never touches the credential-bearing report-file URL.
// The Item Basic Information, Order List and RMA List reports (contracts §17.6 / §17.8) are the
// same job-creating READS; no token was added to or removed from the list below for them.
//
// NOTE (2026-10-15): the sellermgmt reference reads (client.reference.*: Seller Status Check, Get
// Industry List, Get Subcategory Status / Properties / Property Values, contracts §19) are READS,
// four of them via PUT; they are deliberately absent from the list below.
//
// NOTE (2026-10-15): the Shipped-by-Newegg reads (client.sbn.listShipments / getRequestStatus /
// getRequestResult / listWarehouses = Get Inbound Shipment List / Status Request / Request Result,
// Get Warehouse List, contracts §21) are READS, three via PUT, and are deliberately NOT matched.
// Create and Void Inbound Shipment are WRITES that share one endpoint (`shipmentrequest`); that
// endpoint, their OperationType and any `sbn.<create|void|...>` method are listed below. Get
// Inbound Shipment Plan Suggestion is not classified as a read (its page does not say it has no
// side effects, §21.1), so it stays blocked until it is.
const FORBIDDEN: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\.updateItem\s*\(/, why: "inventory write (updateItem)" },
  { re: /\.updateMany\s*\(/, why: "inventory write (updateMany)" },
  { re: /submitInventoryFeed/, why: "feed submission (write)" },
  { re: /submitfeed/i, why: "feed submission endpoint (write)" },
  { re: /["'`]POST["'`]/, why: "raw POST request (all live traffic must be reads)" },
  // Order writes (Phase 2). The read endpoints are deliberately NOT matched: orders.list /
  // orders.get / orders.getStatus. Both the SDK method calls AND the raw wire markers are listed,
  // so neither a `client.orders.ship(...)` call nor a hand-built write body can land in a live test.
  { re: /\.ship\s*\(/, why: "orders.ship (write)" },
  { re: /\.cancel\s*\(/, why: "orders.cancel (write)" },
  { re: /\.confirmDownload\s*\(/, why: "orders.confirmDownload (write)" },
  { re: /\.removeItems\s*\(/, why: "orders.removeItems (write)" },
  { re: /["'`]Action["'`]\s*:/, why: "raw order-action write body (Action = 1 cancel / 2 ship)" },
  { re: /killitem/i, why: "remove-item (KillItem) endpoint (write)" },
  { re: /KillItemRequest|OrderConfirmationRequest/, why: "raw order-write OperationType (write)" },
  { re: /cancel_?status/i, why: "cancel-order endpoint (write)" },
  // RMA / courtesy refund writes (contracts §20). The reads (client.rma.list/get/tryGet,
  // client.refunds.list/get/tryGet/listRequests/getRequestStatus = Get RMA Information, Get Courtesy
  // Refund Information/Request Status) are READS via PUT and are deliberately NOT matched. Submit /
  // Edit / Process / Reject RMA and Issue Courtesy Refund are WRITES: the SDK methods (rma.submit /
  // edit / process / reject, refunds.issue) AND their read-only preview* twins are listed, as are the
  // raw wire markers (endpoints, OperationTypes and body elements), so none can land in a live test.
  {
    re: /\brma\s*\??\.\s*(preview)?(submit|issue|create|edit|update|process|receive|reject|void|close)\w*\s*\(/i,
    why: "rma write method (submit/edit/process/reject RMA, or its preview)",
  },
  {
    re: /\brefunds\s*\??\.\s*(preview)?(issue|create|submit|request|new)\w*\s*\(/i,
    why: "refunds write method (issue courtesy refund, or its preview)",
  },
  {
    re: /servicemgmt\/rma\/(newrma|updaterma)|\bnewrma\b|\bupdaterma\b/i,
    why: "RMA write endpoint",
  },
  { re: /courtesyrefund\/new\b/i, why: "issue-courtesy-refund endpoint (write)" },
  {
    re: /\b(IssueRMA|EditRMA|ReceiveRMA|RejectRMA)(Request|Response)?\b|\bIssueCourtesyRefund\b|\bCourtesyRefundResponse\b/,
    why: "raw RMA/courtesy-refund write OperationType (write)",
  },
  {
    re: /\b(EditRMAInfo|ReceiveRMAInfo|RejectRMAInfo|AutoReceiveMark|TotalRefundAmount|SourceSONumber)\b/,
    why: "raw RMA/courtesy-refund write body element (write)",
  },
  // Shipped-by-Newegg inbound-shipment writes (contracts §21). The reads (client.sbn.listShipments /
  // getRequestStatus / getRequestResult / listWarehouses) are deliberately NOT matched. Create and Void
  // Inbound Shipment share one URL (`shipmentrequest`) and one OperationType (`SubmitShipmentRequest`);
  // the SDK method names (and preview twins) and the raw wire markers are listed so none can land in a
  // live test. Plan Suggestion is unclassified (not shown to be side-effect free).
  {
    re: /\bsbn\s*\??\.\s*(preview)?(create|submit|void|cancel|update|edit|plan|suggest)\w*\s*\(/i,
    why: "sbn write method (create/void inbound shipment, or its preview)",
  },
  {
    re: /inboundshipment\/shipmentrequest|\bshipmentrequest\b/i,
    why: "SBN create/void inbound shipment endpoint (write)",
  },
  {
    re: /\bSubmitShipment(Request|Response)\b/,
    why: "raw SBN create/void inbound shipment OperationType (write)",
  },
  {
    re: /inboundshipment\/plansuggestion|\bplansuggestion\b|\bGetPlanSuggestion(Request|Response)\b/i,
    why: "SBN plan-suggestion endpoint (not classified as a read)",
  },
  // Shipping Label Service (contracts §23). Create buys a UPS label and bills the seller; reprint is
  // treated as billable; the estimate is unverified and needs a real order. The SDK namespace is in
  // live-readonly-ast.ts (no method may be called); the wire endpoints and OperationTypes are listed
  // here so a hand-built request cannot land in a live test either.
  {
    re: /\bshippingLabels\s*\??\.\s*\w+\s*\(/i,
    why: "shippingLabels call (buys or reprints a UPS label, or an unverified quote)",
  },
  {
    re: /shippinglabel\/(create|estimate|reprint)shippinglabel|\b(create|estimate|reprint)shippinglabel\b/i,
    why: "Shipping Label Service endpoint (buys or reprints a label)",
  },
  {
    re: /\b(Create|Estimate|Reprint)ShippingLabel(Request|Response)?\b/,
    why: "raw Shipping Label Service OperationType (write)",
  },
  // Sponsored Ads writes (contracts §25). Every Sponsored Ads operation is a POST, so the verb says
  // nothing: the READS (campaign/group/product/keyword/negativekeyword list, match-type list, keyword
  // and targeting suggestions, group/product/keyword performance) are deliberately NOT matched, while
  // the 15 operations that create or change a campaign (spend money) are listed by URL, by SDK method
  // name and by the wire marker that selects the write.
  {
    re: /sponsoredmgmt\/campaign\/(create|update|changestatus)\b/i,
    why: "Sponsored Ads campaign create/update/change-status endpoint (write)",
  },
  {
    re: /sponsoredmgmt\/campaign\/(group|product|keyword)\/(add|update|changestatus)\b/i,
    why: "Sponsored Ads group/product/keyword add/update/change-status endpoint (write)",
  },
  {
    re: /sponsoredmgmt\/campaign\/(negativekeyword\/add|producttargeting\/add|autotargeting\/matchtype(update|changestatus))\b/i,
    why: "Sponsored Ads negative keyword / product targeting / match type write endpoint (write)",
  },
  {
    re: /\bads\s*\??\.\s*(preview)?(create|add|update|change|set|pause|resume|delete|remove|submit|apply)\w*\s*\(/i,
    why: "ads write method (create/add/update/change-status a campaign, group, product or keyword)",
  },
  // Listing creation (Existing Item Creation feed, contracts §13) — WRITE surface.
  { re: /listings\s*\.\s*create\s*\(/, why: "listings.create (write)" },
  { re: /BatchItemCreation/, why: "item-creation feed MessageType (write)" },
  { re: /ITEM_DATA/, why: "item-creation feed request type (write)" },
  // Volume discounts (contracts §22) — the update is a WRITE (VOLUME_DISCOUNT_DATA feed; the direct
  // submit endpoint is unused). The read (volumeDiscounts.get / tryGet = Get Volume Discount, a PUT) is
  // deliberately NOT matched.
  {
    re: /volumeDiscounts\s*\??\.\s*(preview)?update\s*\(/,
    why: "volumeDiscounts.update (volume discount write)",
  },
  { re: /VOLUME_DISCOUNT_DATA/, why: "volume-discount feed request type (write)" },
  {
    re: /\bSubmitVolumeDiscount(Request|Response)\b/,
    why: "raw Submit Volume Discount OperationType (write)",
  },
  { re: /["'`]?VolumeDiscountList["'`]?\s*:/, why: "raw volume-discount feed body (write)" },
  // Price updates (contracts §16) — WRITE surface. The price READS (pricing.get / tryGet /
  // getMany = Get Item Price) are deliberately NOT matched. The SDK call, the wire endpoints (the
  // US price URL is read-on-PUT / write-on-POST; B2B/CAN inventoryandprice is a PUT write) and the
  // write-body markers are all listed, so neither `client.pricing.update(...)` nor a hand-built
  // price body can land in a live test.
  { re: /pricing\s*\??\.\s*update\s*\(/, why: "pricing.update (price write)" },
  { re: /priceUpdateRequest|parsePriceUpdate|PriceUpdate/, why: "price-update write surface" },
  { re: /inventoryandprice/i, why: "inventoryandprice endpoint (price/inventory write)" },
  { re: /international\/price/i, why: "US international price endpoint (write on POST)" },
  { re: /["'`]?PriceList["'`]?\s*:/, why: "raw price-write body (PriceList)" },
  { re: /["'`]?SellingPrice["'`]?\s*:/, why: "raw price-write body (SellingPrice)" },
];

/**
 * Reasons beyond the raw per-line denylist: the denylist again on the comment-stripped source (a
 * comment or line break inside a call chain no longer hides it), then the normalised and AST rules.
 */
function structuralViolations(source: string): string[] {
  const stripped = withoutComments(source);
  const reasons: string[] = [];
  for (const { re, why } of FORBIDDEN) if (re.test(stripped)) reasons.push(why);
  if (/\bfetch\s*\(/.test(stripped)) reasons.push("raw fetch() in the live suite");
  return [...reasons, ...normalizedViolations(source), ...astViolations(source)];
}

/** Every reason `source` breaks the rule: the per-line denylist plus the structural rules. */
function violationsOf(source: string): string[] {
  const reasons: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    for (const { re, why } of FORBIDDEN) if (re.test(line)) reasons.push(why);
  }
  return [...reasons, ...structuralViolations(source)];
}

// The guard proves itself on every run: each known bypass MUST be flagged and each legitimate read
// MUST pass, otherwise the guard would be passing vacuously (live-readonly-rules.ts). A bypass that
// merely fails to parse is not evidence the guard works, so parse failures do not count here.
for (const sample of MUST_FLAG) {
  if (violationsOf(sample).filter((why) => why !== PARSE_FAILURE_REASON).length === 0) {
    fail(`self-test: bypass NOT flagged: ${JSON.stringify(sample)}`);
  }
}
for (const sample of MUST_NOT_PARSE) {
  if (!violationsOf(sample).includes(PARSE_FAILURE_REASON)) {
    fail(`self-test: unparseable source NOT flagged: ${JSON.stringify(sample)}`);
  }
}
for (const sample of MUST_PASS) {
  const reasons = violationsOf(sample);
  if (reasons.length > 0) {
    fail(`self-test: legitimate read flagged (${reasons.join("; ")}): ${JSON.stringify(sample)}`);
  }
}

// Every member of NeweggClient, and every method of a write namespace, must be explicitly classified
// (parsed with the TypeScript compiler, failing closed on anything unreadable), so a new write
// surface cannot appear on the client without the guard noticing. The synthetic cases prove the
// check itself does not fail open.
{
  const base = "export interface FooApi { get(): void; }\n";
  const failOpenCases: ReadonlyArray<string> = [
    `${base}export interface NeweggClient { readonly marketplace: string; readonly orders: FooApi; readonly extra: FooService; }`,
    `${base}export interface NeweggClient { readonly marketplace: string; readonly extra: FooApi | undefined; }`,
    `${base}export interface NeweggClient { readonly marketplace: string; readonly extra: FooApi & Bar; }`,
    `${base}export interface NeweggClient { readonly marketplace: string; submitThing(): void; }`,
    `${base}export interface NeweggClient { readonly marketplace: string; [key: string]: unknown; }`,
    `${base}export interface NeweggClient extends Other { readonly marketplace: string; }`,
    "export interface OrdersApi { list(): void; ship: (x: unknown) => void; }\nexport interface NeweggClient { readonly marketplace: string; readonly orders: OrdersApi; }",
    "export interface OrdersApi { list(): void; sneaky(): void; }\nexport interface NeweggClient { readonly marketplace: string; readonly orders: OrdersApi; }",
    "export interface OrdersApi { list(): void; [k: string]: unknown; }\nexport interface NeweggClient { readonly marketplace: string; readonly orders: OrdersApi; }",
    "export interface OrdersApi extends Base { list(): void; }\nexport interface NeweggClient { readonly marketplace: string; readonly orders: OrdersApi; }",
    "export type NeweggClient = { marketplace: string };",
    "export interface CatalogApi { resolve(): void; deleteAll(): void; }\nexport interface NeweggClient { readonly marketplace: string; readonly catalog: CatalogApi; }",
    "export interface ReportsApi { purgeEverything(): void; }\nexport interface NeweggClient { readonly marketplace: string; readonly reports: ReportsApi; }",
    "export interface FileReportApi { submit(): void; purge(): void; }\nexport interface ReportsApi { itemBasicInfo: FileReportApi; }\nexport interface NeweggClient { readonly marketplace: string; readonly reports: ReportsApi; }",
    "export interface NewReportApi { submit(): void; }\nexport interface ReportsApi { itemBasicInfo: NewReportApi; }\nexport interface NeweggClient { readonly marketplace: string; readonly reports: ReportsApi; }",
  ];
  for (const sample of failOpenCases) {
    if (clientSurfaceProblems(sample).length === 0) {
      fail(`self-test: surface check fails open on: ${JSON.stringify(sample)}`);
    }
  }
  const typesSource = readFileSync(join(root, "packages", "sdk", "src", "types.ts"), "utf8");
  for (const problem of clientSurfaceProblems(typesSource)) fail(problem);
}

let files: string[] = [];
try {
  // Recursive and every script-like extension: a nested or .mts / .js file is still live code.
  files = readdirSync(liveDir, { recursive: true, encoding: "utf8" })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f));
} catch {
  fail(`live test directory missing at ${liveDir} — guard cannot verify anything`);
}
if (files.length === 0 && failures === 0) {
  fail("no live test files found — guard would pass vacuously; fix the path or the suite");
}

for (const file of files) {
  const path = join(liveDir, file);
  const rel = relative(root, path).replaceAll("\\", "/");
  const source = readFileSync(path, "utf8");
  const lines = source.split(/\r?\n/);
  const isTestFile = file.endsWith(".live.test.ts");
  lines.forEach((line, i) => {
    for (const { re, why } of FORBIDDEN) {
      if (re.test(line)) fail(`${rel}:${i + 1} ${why} — the live suite is read-only`);
    }
    // Every live call — tests AND helpers — now goes through the SDK; no raw network access.
    if (/\bfetch\s*\(/.test(line)) {
      fail(
        `${rel}:${i + 1} raw fetch() in the live suite — every live call must go through the SDK`,
      );
    }
  });
  for (const why of new Set(structuralViolations(source))) {
    fail(`${rel} ${why} — the live suite is read-only`);
  }
  // The gate must be code, not a comment that merely mentions it.
  if (isTestFile && !withoutComments(source).includes("describe.skipIf(!liveEnabled)")) {
    fail(`${rel} missing the describe.skipIf(!liveEnabled) gate`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} read-only guard check(s) failed`);
  process.exit(1);
}
console.log(`Live suite read-only guard passed (${files.length} file(s) scanned)`);
