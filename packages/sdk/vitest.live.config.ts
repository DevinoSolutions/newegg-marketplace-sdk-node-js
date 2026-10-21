import { defineConfig } from "vitest/config";

// Opt-in FAST live smoke tests against the real Newegg API (READ-ONLY).
// Gated inside the suite on NEWEGG_LIVE_TESTS=true plus the three credentials;
// never included in the default `npm test` run and never in CI.
// The slow report / catalog-lookup polling tests (`*.slow.live.test.ts`, up to 8 minutes each)
// run separately via `npm run test:live:reports` (vitest.live.reports.config.ts) so this run
// stays well under the time a tool or CI harness is willing to wait (T-5611).
export default defineConfig({
  test: {
    name: "sdk-live",
    environment: "node",
    include: ["test/live/**/*.live.test.ts"],
    exclude: ["test/live/**/*.slow.live.test.ts"],
    root: import.meta.dirname,
    // hookTimeout covers the beforeAll item discovery (an order read plus per-item reads).
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
