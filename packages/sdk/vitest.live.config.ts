import { defineConfig } from "vitest/config";

// Opt-in live smoke tests against the real Newegg API.
// Gated inside the suite on NEWEGG_LIVE_TESTS plus explicit acknowledgement vars;
// never included in the default `npm test` run and never in CI.
export default defineConfig({
  test: {
    name: "sdk-live",
    environment: "node",
    include: ["test/live/**/*.live.test.ts"],
    root: import.meta.dirname,
    testTimeout: 120_000,
  },
});
