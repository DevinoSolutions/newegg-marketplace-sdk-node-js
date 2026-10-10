import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, SENTINELS, startHarness } from "./helpers.js";

// Wire shapes: contracts §15 (official samples; numbers/booleans as strings on the US read).
const CA_PRICE = {
  Active: "1",
  ItemNumber: "9SIA0060884598",
  SellerID: "A006",
  SellerPartNumber: "SPN-1",
  ShipByNewegg: "0",
  EnableFreeShipping: "1",
  MAP: 25.99,
  CheckoutMAP: 0,
  OnPromotion: "1,5",
  SellingPrice: 20.92,
  LimitQuantity: 1,
};

const US_PRICE = {
  SellerID: "A006",
  ItemNumber: "9SIA0060884598",
  SellerPartNumber: "SPN-1",
  PriceList: {
    Price: {
      CountryCode: "USA",
      Currency: "USD",
      Active: "1",
      MAP: "25.99",
      CheckoutMAP: "0",
      SellingPrice: "20.92",
      EnableFreeShipping: "1",
      LimitQuantity: "2",
    },
  },
};

const caRoute: MockRoute = {
  method: "POST",
  pathPattern: /contentmgmt\/item\/price\?/,
  reply: (req) => {
    const value = (req.bodyJson as { Value: string }).Value;
    return value === "MISSING"
      ? { status: 400, body: [{ Code: "CT026", Message: "Item does not exist" }] }
      : { status: 200, body: { ...CA_PRICE, SellerPartNumber: value } };
  },
};

describe("newegg_pricing_get (end-to-end)", () => {
  it("is a read-only tool", async () => {
    const harness = await startHarness({ routes: [caRoute] });
    try {
      const { tools } = (await harness.mcp.listTools()) as {
        tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      };
      const tool = tools.find((t) => t.name === "newegg_pricing_get");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("returns normalized CA prices with an inferred currency and splits out missing items", async () => {
    const harness = await startHarness({ routes: [caRoute] });
    try {
      const res = await callTool(harness.mcp, "newegg_pricing_get", {
        identifiers: [
          { type: "sellerPartNumber", value: "SPN-1" },
          { type: "sellerPartNumber", value: "MISSING" },
        ],
      });
      expect(res.isError).toBe(false);
      expect(res.json.marketplace).toBe("ca");
      expect(res.json.totalCount).toBe(1);
      expect(res.json.missingIdentifiers).toEqual([{ type: "sellerPartNumber", value: "MISSING" }]);
      expect(res.json.failures).toEqual([]);
      const items = res.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        itemNumber: "9SIA0060884598",
        sellerPartNumber: "SPN-1",
        shippedByNewegg: false,
      });
      expect(items[0]?.prices).toEqual([
        {
          currency: "CAD",
          currencyInferred: true,
          active: true,
          map: 25.99,
          checkoutMap: false,
          sellingPrice: 20.92,
          freeShipping: true,
          promotions: ["priceLock", "volumeDiscount"],
          limitQuantity: 1,
        },
      ]);
      // Never leaks raw upstream bodies or credentials.
      expect(res.text).not.toContain("SellerID");
      expect(res.text).not.toContain(SENTINELS.apiKey);
      expect(res.text).not.toContain(SENTINELS.secretKey);
    } finally {
      await harness.close();
    }
  });

  it("reads US prices with PUT and forwards the country filter", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MARKETPLACE: "us" }),
      routes: [
        {
          method: "PUT",
          pathPattern: /international\/price\?/,
          reply: () => ({ status: 200, body: US_PRICE }),
        },
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_pricing_get", {
        identifiers: [{ type: "sellerPartNumber", value: "SPN-1" }],
        countries: ["USA"],
      });
      expect(res.isError).toBe(false);
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]?.method).toBe("PUT");
      expect(harness.calls[0]?.bodyJson).toEqual({
        Type: "1",
        Value: "SPN-1",
        CountryList: { CountryCode: ["USA"] },
      });
      const items = res.json.items as Array<{ prices: Array<Record<string, unknown>> }>;
      expect(items[0]?.prices[0]).toMatchObject({
        countryCode: "USA",
        currency: "USD",
        currencyInferred: false,
        sellingPrice: 20.92,
      });
    } finally {
      await harness.close();
    }
  });

  it("reports per-item upstream errors in failures instead of failing the call", async () => {
    const harness = await startHarness({
      routes: [
        {
          method: "POST",
          pathPattern: /contentmgmt\/item\/price\?/,
          reply: () => ({
            status: 400,
            body: [{ Code: "CT007", Message: "Invalid selling price" }],
          }),
        },
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_pricing_get", {
        identifiers: [{ type: "sellerPartNumber", value: "SPN-1" }],
      });
      expect(res.isError).toBe(false);
      expect(res.json.items).toEqual([]);
      const failures = res.json.failures as Array<Record<string, unknown>>;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        identifier: { type: "sellerPartNumber", value: "SPN-1" },
        errorCode: "CT007",
        httpStatus: 400,
      });
    } finally {
      await harness.close();
    }
  });

  it("returns a structured error for bad credentials", async () => {
    const harness = await startHarness({
      routes: [
        {
          method: "POST",
          pathPattern: /contentmgmt\/item\/price\?/,
          reply: () => ({ status: 401, body: "Gateway: Seller Auth failed." }),
        },
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_pricing_get", {
        identifiers: [{ type: "sellerPartNumber", value: "SPN-1" }],
      });
      expect(res.isError).toBe(true);
      expect(res.json.errorCode).toBe("authentication");
    } finally {
      await harness.close();
    }
  });

  it("rejects bad input before any HTTP call", async () => {
    const harness = await startHarness({ routes: [caRoute] });
    try {
      const tooMany = Array.from({ length: 101 }, (_, i) => ({
        type: "sellerPartNumber",
        value: `S${i}`,
      }));
      const bad: Array<Record<string, unknown>> = [
        { identifiers: [] },
        { identifiers: tooMany },
        { identifiers: [{ type: "sellerPartNumber", value: "A" }], countries: ["usa"] },
        { identifiers: [{ type: "sellerPartNumber", value: "A" }], price: 1 },
        { identifiers: [{ type: "sellerPartNumber", value: "A" }], apiKey: "x" },
      ];
      for (const args of bad) {
        const res = await callTool(harness.mcp, "newegg_pricing_get", args);
        expect(res.isError).toBe(true);
      }
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
