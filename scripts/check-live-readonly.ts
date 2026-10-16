// Enforces the repository rule that the live test suite is READ-ONLY.
// The live tests in packages/sdk/test/live/ hit the REAL Newegg seller account;
// they must never mutate it. This guard fails CI when a live file gains a
// mutating SDK call, a raw POST, an ungated describe block, or when the guard
// itself would pass vacuously (no files found).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MUST_FLAG, MUST_PASS, normalizedViolations } from "./live-readonly-rules.js";

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
  // Listing creation (Existing Item Creation feed, contracts §13) — WRITE surface.
  { re: /listings\s*\.\s*create\s*\(/, why: "listings.create (write)" },
  { re: /BatchItemCreation/, why: "item-creation feed MessageType (write)" },
  { re: /ITEM_DATA/, why: "item-creation feed request type (write)" },
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

/** Every reason `source` breaks the rule: the per-line denylist plus the normalised allowlist. */
function violationsOf(source: string): string[] {
  const reasons: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    for (const { re, why } of FORBIDDEN) if (re.test(line)) reasons.push(why);
  }
  return [...reasons, ...normalizedViolations(source)];
}

// The guard proves itself on every run: each known bypass MUST be flagged and each legitimate read
// MUST pass, otherwise the guard would be passing vacuously (live-readonly-rules.ts).
for (const sample of MUST_FLAG) {
  if (violationsOf(sample).length === 0) {
    fail(`self-test: bypass NOT flagged: ${JSON.stringify(sample)}`);
  }
}
for (const sample of MUST_PASS) {
  const reasons = violationsOf(sample);
  if (reasons.length > 0) {
    fail(`self-test: legitimate read flagged (${reasons.join("; ")}): ${JSON.stringify(sample)}`);
  }
}

let files: string[] = [];
try {
  files = readdirSync(liveDir).filter((f) => f.endsWith(".ts"));
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
  for (const why of normalizedViolations(source)) {
    fail(`${rel} ${why} — the live suite is read-only`);
  }
  if (isTestFile && !lines.some((l) => l.includes("describe.skipIf(!liveEnabled)"))) {
    fail(`${rel} missing the describe.skipIf(!liveEnabled) gate`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} read-only guard check(s) failed`);
  process.exit(1);
}
console.log(`Live suite read-only guard passed (${files.length} file(s) scanned)`);
