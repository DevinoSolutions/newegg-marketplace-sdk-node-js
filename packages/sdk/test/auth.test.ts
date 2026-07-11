import { describe, expect, it } from "vitest";
import { NeweggAuthenticationError } from "../src/index.js";
import {
  capturingLogger,
  makeClient,
  paths,
  TEST_API_KEY,
  TEST_SECRET_KEY,
  US_SINGLE_ITEM,
} from "./helpers.js";

describe("auth headers & redaction", () => {
  it("sends Authorization and SecretKey as raw header values", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
      },
    ]);
    await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "A006BSP3" } });

    expect(calls[0]!.headers.get("Authorization")).toBe(TEST_API_KEY);
    expect(calls[0]!.headers.get("SecretKey")).toBe(TEST_SECRET_KEY);
    expect(calls[0]!.headers.get("Content-Type")).toBe("application/json");
    expect(calls[0]!.headers.get("Accept")).toBe("application/json");
    expect(calls[0]!.headers.get("User-Agent")).toMatch(/newegg-marketplace-sdk/);
  });

  it("preserves the original seller id case in the query", async () => {
    const { client, calls } = makeClient(
      "us",
      [
        {
          method: "PUT",
          pathPattern: paths.usInventory,
          reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
        },
      ],
      { sellerId: "A006Xy" },
    );
    await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });
    expect(calls[0]!.url.searchParams.get("sellerid")).toBe("A006Xy");
  });

  it("never leaks credentials in a thrown auth error", async () => {
    const { client } = makeClient("us", [
      {
        method: "PUT",
        pathPattern: paths.usInventory,
        reply: () => ({ status: 401, body: "Gateway: Seller Auth failed." }),
      },
    ]);
    let error: unknown;
    try {
      await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(NeweggAuthenticationError);
    const serialized = JSON.stringify((error as NeweggAuthenticationError).toJSON());
    expect(serialized).not.toContain(TEST_API_KEY);
    expect(serialized).not.toContain(TEST_SECRET_KEY);
    expect((error as Error).message).not.toContain(TEST_API_KEY);
    expect((error as Error).message).not.toContain(TEST_SECRET_KEY);
  });

  it("logs a sellerIdHash and never the raw seller id or secrets", async () => {
    const { logger, entries } = capturingLogger();
    const { client } = makeClient(
      "us",
      [
        {
          method: "PUT",
          pathPattern: paths.usInventory,
          reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
        },
      ],
      { logger, sellerId: "SELLER-RAW-123" },
    );
    await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });

    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(TEST_API_KEY);
    expect(dump).not.toContain(TEST_SECRET_KEY);
    expect(dump).not.toContain("SELLER-RAW-123");
    expect(entries.some((entry) => typeof entry.fields?.sellerIdHash === "string")).toBe(true);
  });
});
