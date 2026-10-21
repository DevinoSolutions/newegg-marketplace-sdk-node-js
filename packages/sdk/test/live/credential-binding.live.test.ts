import { describe, expect, it } from "vitest";
import {
  createNeweggClient,
  NeweggConfigurationError,
  NeweggMarketplaceMismatchError,
} from "../../src/index.js";
import { liveEnabled } from "./helpers.js";

/**
 * NO-NETWORK guard check (T-5911). It lives in the live suite because that is where the
 * "which marketplace do these keys belong to" question matters (so it follows the suite's
 * `liveEnabled` gate), but it never reads credentials and never issues a request: the SDK
 * refuses the combination while resolving the config, and the fetch below would fail the test if
 * it were ever called. Read-only by construction.
 */
describe.skipIf(!liveEnabled)(
  "live (read-only): credential/marketplace binding (no network)",
  () => {
    const neverCalled: typeof globalThis.fetch = () => {
      throw new Error("a mismatched client must not issue any request");
    };

    for (const target of ["us", "b2b"] as const) {
      it(`refuses ca-issued keys on a ${target} client before any request`, () => {
        let thrown: unknown;
        try {
          createNeweggClient({
            sellerId: "PLACEHOLDER",
            apiKey: "placeholder-api-key",
            secretKey: "placeholder-secret-key",
            marketplace: target,
            credentialMarketplace: "ca",
            fetch: neverCalled,
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(NeweggMarketplaceMismatchError);
        expect(thrown).toBeInstanceOf(NeweggConfigurationError);
        expect(JSON.stringify(thrown)).not.toContain("placeholder");
      });
    }
  },
);
