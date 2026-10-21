import { describe, expect, it } from "vitest";
import {
  createNeweggClient,
  NeweggConfigurationError,
  NeweggError,
  NeweggMarketplaceMismatchError,
} from "../src/index.js";
import type { NeweggMarketplace } from "../src/index.js";
import { createMockFetch } from "../src/testing/index.js";
import { TEST_API_KEY, TEST_SECRET_KEY } from "./helpers.js";

function make(marketplace: NeweggMarketplace, credentialMarketplace?: unknown) {
  const { fetch, calls } = createMockFetch([]);
  const build = () =>
    createNeweggClient({
      sellerId: "A006",
      apiKey: TEST_API_KEY,
      secretKey: TEST_SECRET_KEY,
      marketplace,
      fetch,
      ...(credentialMarketplace === undefined
        ? {}
        : { credentialMarketplace: credentialMarketplace as NeweggMarketplace }),
    });
  return { build, calls };
}

describe("credentialMarketplace binding (T-5911)", () => {
  for (const marketplace of ["us", "b2b", "ca"] as const) {
    it(`builds a client when credentialMarketplace matches ${marketplace}`, () => {
      expect(make(marketplace, marketplace).build().marketplace).toBe(marketplace);
    });

    it(`builds a client when credentialMarketplace is absent (${marketplace})`, () => {
      expect(make(marketplace).build().marketplace).toBe(marketplace);
    });
  }

  for (const [credential, target] of [
    ["ca", "us"],
    ["ca", "b2b"],
    ["us", "ca"],
    ["us", "b2b"],
    ["b2b", "us"],
    ["b2b", "ca"],
  ] as const) {
    it(`refuses ${credential} credentials on a ${target} client before any request`, () => {
      const { build, calls } = make(target, credential);
      let thrown: unknown;
      try {
        build();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NeweggMarketplaceMismatchError);
      expect(thrown).toBeInstanceOf(NeweggConfigurationError);
      expect(thrown).toBeInstanceOf(NeweggError);
      const error = thrown as NeweggMarketplaceMismatchError;
      expect(error.code).toBe("configuration");
      expect(error.name).toBe("NeweggMarketplaceMismatchError");
      expect(error.expectedMarketplace).toBe(target);
      expect(error.actualMarketplace).toBe(credential);
      expect(calls).toHaveLength(0);
      const serialized = `${error.message} ${JSON.stringify(error.toJSON())}`;
      for (const secret of [TEST_API_KEY, TEST_SECRET_KEY, "A006"]) {
        expect(serialized).not.toContain(secret);
      }
      expect(error.toJSON()).toMatchObject({
        code: "configuration",
        expectedMarketplace: target,
        actualMarketplace: credential,
      });
    });
  }

  it("rejects an invalid credentialMarketplace value as a plain configuration error", () => {
    let thrown: unknown;
    try {
      make("ca", "eu").build();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NeweggConfigurationError);
    expect(thrown).not.toBeInstanceOf(NeweggMarketplaceMismatchError);
    expect((thrown as Error).message).toContain("credentialMarketplace");
  });

  it("rejects an empty-string credentialMarketplace", () => {
    expect(() => make("ca", "").build()).toThrow(NeweggConfigurationError);
  });
});
