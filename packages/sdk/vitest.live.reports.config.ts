import { defineConfig } from "vitest/config";

// Opt-in SLOW live tests (READ-ONLY): report submit/poll/fetch and the catalog item lookup.
// Report submission creates a read-only job (contracts sections 12 and 17) and is budgeted at
// ONE submission per test per run (100/hour), so files run one after another, not in parallel.
// Run: NEWEGG_LIVE_TESTS=true npm run test:live:reports  (best in the background, output to a file).
// testTimeout must stay >= the largest per-test timeout in these files (480_000 in
// reports-lists-read.slow.live.test.ts); the per-test timeouts are what actually bound each test.
export default defineConfig({
  test: {
    name: "sdk-live-reports",
    environment: "node",
    include: ["test/live/**/*.slow.live.test.ts"],
    root: import.meta.dirname,
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 120_000,
  },
});
