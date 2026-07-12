// Enforces the repository rule that the live test suite is READ-ONLY.
// The live tests in packages/sdk/test/live/ hit the REAL Newegg seller account;
// they must never mutate it. This guard fails CI when a live file gains a
// mutating SDK call, a raw POST, an ungated describe block, or when the guard
// itself would pass vacuously (no files found).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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
const FORBIDDEN: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\.updateItem\s*\(/, why: "inventory write (updateItem)" },
  { re: /\.updateMany\s*\(/, why: "inventory write (updateMany)" },
  { re: /submitInventoryFeed/, why: "feed submission (write)" },
  { re: /submitfeed/i, why: "feed submission endpoint (write)" },
  { re: /["'`]POST["'`]/, why: "raw POST request (all live traffic must be reads)" },
  // Order writes (Phase 2 — guarded AHEAD of implementation so a live write test can never slip
  // in). These read endpoints are deliberately NOT matched: orders.list / orders.get /
  // orders.getStatus. Extend this group when the order-mutation methods actually land.
  { re: /\.shipOrder\s*\(/, why: "order ship (write)" },
  { re: /\.cancelOrder\s*\(/, why: "order cancel (write)" },
  { re: /\.confirmOrder\s*\(/, why: "order confirmation (write)" },
  { re: /["'`]Action["'`]\s*:/, why: "raw order-action write body (Action = ship/cancel/confirm)" },
  { re: /cancel_?status/i, why: "cancel-order endpoint (write)" },
];

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
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const isTestFile = file.endsWith(".live.test.ts");
  lines.forEach((line, i) => {
    for (const { re, why } of FORBIDDEN) {
      if (re.test(line)) fail(`${rel}:${i + 1} ${why} — the live suite is read-only`);
    }
    // Raw network calls are confined to helpers.ts (read-only discovery); tests go through the SDK.
    if (isTestFile && /\bfetch\s*\(/.test(line)) {
      fail(`${rel}:${i + 1} raw fetch() in a live test — go through the SDK or helpers.ts`);
    }
  });
  if (isTestFile && !lines.some((l) => l.includes("describe.skipIf(!liveEnabled)"))) {
    fail(`${rel} missing the describe.skipIf(!liveEnabled) gate`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} read-only guard check(s) failed`);
  process.exit(1);
}
console.log(`Live suite read-only guard passed (${files.length} file(s) scanned)`);
