import { describe, expect, it } from "vitest";
import { createNeweggClient, NeweggConfigurationError } from "../src/index.js";
import { createMockFetch } from "../src/testing/index.js";

describe("smoke", () => {
  it("creates a client and resolves src .js specifiers", () => {
    const { fetch } = createMockFetch([]);
    const client = createNeweggClient({
      sellerId: "A006",
      apiKey: "key",
      secretKey: "secret",
      marketplace: "us",
      fetch,
    });
    expect(client.marketplace).toBe("us");
  });

  it("throws NeweggConfigurationError for a bad marketplace", () => {
    expect(() =>
      createNeweggClient({
        sellerId: "A006",
        apiKey: "key",
        secretKey: "secret",
        // @ts-expect-error invalid marketplace
        marketplace: "xx",
      }),
    ).toThrow(NeweggConfigurationError);
  });
});
