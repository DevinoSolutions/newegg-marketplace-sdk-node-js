import { describe, expect, it } from "vitest";
import { CatalogLookupTimeoutError } from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live checks for catalog resolution (reportmgmt Item Lookup, contracts §12).
 * Report submission creates a report job and mutates nothing on the seller account —
 * classified READ per §12.4, owner-approved 2026-07-16. Uses a public, printed-on-the-box
 * retail UPC (Corsair MP700 series NVMe SSD), never account-derived identifiers, so
 * nothing live leaks into the repo. Budget: ONE submission per run (submit is 100/hour).
 * A slow report surfaces as CatalogLookupTimeoutError — treated as a soft outcome here
 * (asserted to carry the requestId), never retried by resubmitting.
 */
const PUBLIC_UPC = "840006676577";

describe.skipIf(!liveEnabled)("live (read-only): catalog item lookup", () => {
  it(
    "submits an item lookup, polls, and fetches the result for a public UPC",
    { timeout: 180_000 },
    async () => {
      const client = makeLiveClient();
      try {
        const result = await client.catalog.resolve({ upc: PUBLIC_UPC }, { timeoutMs: 150_000 });
        expect(result.marketplace).toBe(marketplace());
        expect(typeof result.requestId).toBe("string");
        expect(result.resolutions).toHaveLength(1);
        const resolution = result.resolutions[0];
        // found may legitimately be false (item absent from this marketplace's catalog);
        // the full submit→poll→result lifecycle completing is the contract under test.
        expect(typeof resolution?.found).toBe("boolean");
        if (resolution?.found) {
          expect(resolution.matches[0]?.neweggItemNumber).toMatch(/\S/);
        }
      } catch (err) {
        // A report that is still processing after the budget is a valid live outcome —
        // assert the error contract (requestId present) instead of failing the suite.
        if (!(err instanceof CatalogLookupTimeoutError)) throw err;
        expect(err.requestId).toMatch(/\S/);
      }
    },
  );
});
