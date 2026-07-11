import { describe, expect, it } from "vitest";
import { createNeweggClient, NeweggConfigurationError } from "../src/index.js";
import { createMockFetch } from "../src/testing/index.js";
import { ITEM_SINGLE_ITEM, makeClient, paths, US_SINGLE_ITEM } from "./helpers.js";

describe("URL construction", () => {
  it("uses the US international inventory path (PUT), all-lowercase", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
      },
    ]);
    await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });
    expect(calls[0]!.url.pathname).toBe("/marketplace/contentmgmt/item/international/inventory");
    expect(calls[0]!.url.pathname).toBe(calls[0]!.url.pathname.toLowerCase());
    expect(calls[0]!.url.searchParams.get("version")).toBeNull();
  });

  it("uses the b2b prefix and version=304 on single-item reads", async () => {
    const { client, calls } = makeClient("b2b", [
      {
        method: "POST",
        pathPattern: paths.itemInventory,
        reply: () => ({ status: 200, body: ITEM_SINGLE_ITEM }),
      },
    ]);
    await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });
    expect(calls[0]!.url.pathname).toBe("/marketplace/b2b/contentmgmt/item/inventory");
    expect(calls[0]!.url.searchParams.get("version")).toBe("304");
  });

  it("uses the can prefix and version=304 on single-item reads", async () => {
    const { client, calls } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.itemInventory,
        reply: () => ({ status: 200, body: ITEM_SINGLE_ITEM }),
      },
    ]);
    await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });
    expect(calls[0]!.url.pathname).toBe("/marketplace/can/contentmgmt/item/inventory");
    expect(calls[0]!.url.searchParams.get("version")).toBe("304");
  });

  it("keeps identifier values with special characters in the body, never the path", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
      },
    ]);
    await client.inventory.getItem({
      identifier: { type: "sellerPartNumber", value: "a/b?c d&e" },
    });
    expect(calls[0]!.url.pathname).toBe("/marketplace/contentmgmt/item/international/inventory");
    expect((calls[0]!.bodyJson as { Value: string }).Value).toBe("a/b?c d&e");
  });

  it("honors a trusted baseUrl override", async () => {
    const { client, calls } = makeClient(
      "us",
      [
        {
          method: "PUT",
          pathPattern: paths.usInventory,
          reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
        },
      ],
      { baseUrl: "http://127.0.0.1:8099/marketplace/" },
    );
    await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });
    expect(calls[0]!.url.origin).toBe("http://127.0.0.1:8099");
  });

  it("rejects a non-https baseUrl that is not loopback", () => {
    const { fetch } = createMockFetch([]);
    expect(() =>
      createNeweggClient({
        sellerId: "A006",
        apiKey: "k",
        secretKey: "s",
        marketplace: "us",
        fetch,
        baseUrl: "http://api.example.com/marketplace/",
      }),
    ).toThrow(NeweggConfigurationError);
  });

  it("rejects a baseUrl that does not end with a slash", () => {
    const { fetch } = createMockFetch([]);
    expect(() =>
      createNeweggClient({
        sellerId: "A006",
        apiKey: "k",
        secretKey: "s",
        marketplace: "us",
        fetch,
        baseUrl: "https://api.newegg.com/marketplace",
      }),
    ).toThrow(NeweggConfigurationError);
  });
});
