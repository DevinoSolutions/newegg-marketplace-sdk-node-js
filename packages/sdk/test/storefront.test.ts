import { describe, expect, it } from "vitest";
import {
  NeweggApiError,
  NeweggValidationError,
  UnsupportedMarketplaceOperationError,
} from "../src/errors/index.js";
import { STOREFRONT_USER_AGENT } from "../src/storefront/constants.js";
import { normalizeParentItemNumber, parentFromRedirectLocation } from "../src/storefront/parse.js";
import type { MockRoute } from "../src/testing/index.js";
import { makeClient, paths } from "./helpers.js";

// All fixtures below are synthetic: fictional seller ids/offer numbers, real-shaped payloads.
const PARENT = "20-156-294";
const OFFER_NUMBER = "9SIAB1200000001";

/** §14.1 MoreBuyingOptions sample: a Newegg first-party row followed by marketplace rows. */
const MBO_BODY = {
  ItemInfo: [
    {
      Item: PARENT,
      UnitCost: 129.99,
      // Observed live: 0.01 even on offers the page labels "Free Shipping".
      ShippingCharge: 0.01,
      Instock: true,
      Active: "1",
      IsActivated: true,
      Seller: null,
      SomeUndocumentedField: "ignored",
    },
    {
      Item: OFFER_NUMBER,
      UnitCost: 134.5,
      ShippingCharge: 0,
      Instock: true,
      Active: "1",
      IsActivated: true,
      Seller: { SellerId: "AB12", SellerName: "Example Seller Inc", SellerRating: 4.8 },
    },
    {
      Item: "9SICD3400000002",
      UnitCost: "140.00",
      ShippingCharge: "9.99",
      Instock: false,
      Active: "0",
      IsActivated: false,
      Seller: { SellerId: "CD34", SellerName: "Second Example Seller" },
    },
  ],
  TabInfo: [],
  Total: 3,
  CurrentPageNum: 1,
  PageCount: 1,
};

function offersRoute(body: unknown, status = 200): MockRoute {
  return {
    method: "GET",
    pathPattern: paths.moreBuyingOptions,
    // The storefront answers with text/plain even though the body is JSON.
    reply: () => ({ status, body, headers: { "Content-Type": "text/plain; charset=utf-8" } }),
  };
}

function redirectRoute(location: string | undefined, status = 301): MockRoute {
  const headers: Record<string, string> = location === undefined ? {} : { Location: location };
  return {
    method: "GET",
    pathPattern: paths.storefrontProductPage,
    reply: () => ({ status, headers }),
  };
}

// ---------------------------------------------------------------------------
// parent-number normalization (unit)
// ---------------------------------------------------------------------------
describe("storefront parent item number normalization", () => {
  it("passes through the dashed catalog form and marketplace CODEs", () => {
    expect(normalizeParentItemNumber(PARENT)).toBe(PARENT);
    expect(normalizeParentItemNumber(" 3C6-00T1-002H0 ")).toBe("3C6-00T1-002H0");
    expect(normalizeParentItemNumber("0D9-002W-000F0")).toBe("0D9-002W-000F0");
  });

  it("normalizes the product-page and bare-digit forms to the dashed form", () => {
    expect(normalizeParentItemNumber("N82E16820156294")).toBe(PARENT);
    expect(normalizeParentItemNumber("n82e16820156294")).toBe(PARENT);
    expect(normalizeParentItemNumber("20156294")).toBe(PARENT);
  });

  it("rejects an empty value", () => {
    expect(normalizeParentItemNumber("   ")).toBeUndefined();
  });

  it("extracts the parent from both observed redirect Location shapes", () => {
    expect(
      parentFromRedirectLocation(
        "https://www.newegg.ca/example-product-slug/p/N82E16820156294",
        "https://www.newegg.ca",
      ),
    ).toBe(PARENT);
    expect(
      parentFromRedirectLocation("https://www.newegg.ca/p/3C6-00T1-002H0", "https://www.newegg.ca"),
    ).toBe("3C6-00T1-002H0");
    expect(parentFromRedirectLocation("/p/0D9-002W-000F0", "https://www.newegg.ca")).toBe(
      "0D9-002W-000F0",
    );
    expect(
      parentFromRedirectLocation("https://www.newegg.ca/", "https://www.newegg.ca"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getOffers by parent item number
// ---------------------------------------------------------------------------
describe("storefront.getOffers by item number", () => {
  it("normalizes every offer and treats the first as the buy box", async () => {
    const { client, calls } = makeClient("ca", [offersRoute(MBO_BODY)]);
    const result = await client.storefront.getOffers({ itemNumber: PARENT });

    expect(result.parentItemNumber).toBe(PARENT);
    expect(result.total).toBe(3);
    expect(result.offers).toHaveLength(3);
    expect(result.buyBox).toEqual(result.offers[0]);

    // Newegg first-party: Seller is null.
    expect(result.offers[0]).toEqual({
      offerItemNumber: PARENT,
      sellerName: undefined,
      sellerId: undefined,
      isNewegg: true,
      price: 129.99,
      shippingCharge: 0.01,
      inStock: true,
      active: true,
    });
    // Marketplace seller.
    expect(result.offers[1]).toEqual({
      offerItemNumber: OFFER_NUMBER,
      sellerName: "Example Seller Inc",
      sellerId: "AB12",
      isNewegg: false,
      price: 134.5,
      shippingCharge: 0,
      inStock: true,
      active: true,
    });
    // String-typed numbers and "0" booleans coerce.
    expect(result.offers[2]).toMatchObject({
      price: 140,
      shippingCharge: 9.99,
      inStock: false,
      active: false,
      isNewegg: false,
    });

    expect(calls).toHaveLength(1);
    const url = calls[0]?.url;
    expect(url?.origin).toBe("https://www.newegg.ca");
    expect(url?.pathname).toBe("/product/api/MoreBuyingOptions");
    expect(url?.searchParams.get("ParentItem")).toBe(PARENT);
    expect(url?.searchParams.get("TabType")).toBe("0");
    expect(url?.searchParams.get("PageSize")).toBe("10");
    expect(url?.searchParams.get("FirstCall")).toBe("true");
    // No seller credentials are ever sent to the public storefront.
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(calls[0]?.headers.get("user-agent")).toBe(STOREFRONT_USER_AGENT);
    expect(calls[0]?.headers.get("referer")).toBe("https://www.newegg.ca/");
    expect(calls[0]?.headers.get("accept")).toBe("application/json, text/plain, */*");
  });

  it("parses a text/plain response body that contains JSON", async () => {
    const { client } = makeClient("ca", [
      {
        method: "GET",
        pathPattern: paths.moreBuyingOptions,
        reply: () => ({
          status: 200,
          body: JSON.stringify(MBO_BODY),
          headers: { "Content-Type": "text/plain" },
        }),
      },
    ]);
    const result = await client.storefront.getOffers({ itemNumber: PARENT });
    expect(result.offers).toHaveLength(3);
  });

  it("treats an empty SellerId object as a Newegg first-party offer", async () => {
    const { client } = makeClient("ca", [
      offersRoute({
        ItemInfo: [
          {
            Item: PARENT,
            UnitCost: 99,
            ShippingCharge: 0.01,
            Instock: true,
            Active: "1",
            Seller: { SellerId: "", SellerName: null },
          },
        ],
        Total: 1,
      }),
    ]);
    const result = await client.storefront.getOffers({ itemNumber: PARENT });
    expect(result.offers[0]?.isNewegg).toBe(true);
    expect(result.offers[0]?.sellerId).toBeUndefined();
    expect(result.offers[0]?.sellerName).toBeUndefined();
  });

  it("normalizes an N82E168-form item number before requesting", async () => {
    const { client, calls } = makeClient("ca", [offersRoute(MBO_BODY)]);
    await client.storefront.getOffers({ itemNumber: "N82E16820156294" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get("ParentItem")).toBe(PARENT);
  });

  it("returns an undefined buy box when the product has no offers", async () => {
    const { client } = makeClient("ca", [offersRoute({ ItemInfo: [], Total: 0 })]);
    const result = await client.storefront.getOffers({ itemNumber: PARENT });
    expect(result.offers).toEqual([]);
    expect(result.buyBox).toBeUndefined();
    expect(result.total).toBe(0);
  });

  it("uses the .com origin for the us marketplace", async () => {
    const { client, calls } = makeClient("us", [offersRoute(MBO_BODY)]);
    await client.storefront.getOffers({ itemNumber: PARENT });
    expect(calls[0]?.url.origin).toBe("https://www.newegg.com");
    expect(calls[0]?.headers.get("referer")).toBe("https://www.newegg.com/");
  });

  it("rejects an empty item number before any request", async () => {
    const { client, calls } = makeClient("ca", [offersRoute(MBO_BODY)]);
    await expect(client.storefront.getOffers({ itemNumber: "  " })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getOffers by seller offer number (301 parent resolution)
// ---------------------------------------------------------------------------
describe("storefront.getOffers by offer number", () => {
  it("resolves the parent from a product-page slug redirect, then fetches offers", async () => {
    const { client, calls } = makeClient("ca", [
      offersRoute(MBO_BODY),
      redirectRoute("https://www.newegg.ca/example-product-slug/p/N82E16820156294"),
    ]);
    const result = await client.storefront.getOffers({ offerNumber: OFFER_NUMBER });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.pathname).toBe(`/p/${OFFER_NUMBER}`);
    expect(calls[1]?.url.searchParams.get("ParentItem")).toBe(PARENT);
    expect(result.parentItemNumber).toBe(PARENT);
    expect(result.buyBox?.offerItemNumber).toBe(PARENT);
  });

  it("resolves a CODE-form parent redirect", async () => {
    const { client, calls } = makeClient("ca", [
      offersRoute({ ItemInfo: [], Total: 0 }),
      redirectRoute("https://www.newegg.ca/p/3C6-00T1-002H0"),
    ]);
    const result = await client.storefront.getOffers({ offerNumber: OFFER_NUMBER });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.searchParams.get("ParentItem")).toBe("3C6-00T1-002H0");
    expect(result.parentItemNumber).toBe("3C6-00T1-002H0");
  });

  it("throws when the product page does not redirect", async () => {
    const { client } = makeClient("ca", [offersRoute(MBO_BODY), redirectRoute(undefined, 200)]);
    await expect(client.storefront.getOffers({ offerNumber: OFFER_NUMBER })).rejects.toBeInstanceOf(
      NeweggApiError,
    );
  });

  it("throws when the redirect Location carries no parent item number", async () => {
    const { client } = makeClient("ca", [
      offersRoute(MBO_BODY),
      redirectRoute("https://www.newegg.ca/"),
    ]);
    await expect(client.storefront.getOffers({ offerNumber: OFFER_NUMBER })).rejects.toBeInstanceOf(
      NeweggApiError,
    );
  });

  it("rejects an empty offer number before any request", async () => {
    const { client, calls } = makeClient("ca", [offersRoute(MBO_BODY)]);
    await expect(client.storefront.getOffers({ offerNumber: "" })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// failure modes
// ---------------------------------------------------------------------------
describe("storefront failure modes", () => {
  it("throws NeweggApiError when the body is not JSON", async () => {
    const { client } = makeClient("ca", [
      {
        method: "GET",
        pathPattern: paths.moreBuyingOptions,
        reply: () => ({
          status: 200,
          body: "<!DOCTYPE html><html><body>Access Denied</body></html>",
          headers: { "Content-Type": "text/html" },
        }),
      },
    ]);
    const error = await client.storefront
      .getOffers({ itemNumber: PARENT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as NeweggApiError).message).toMatch(/non-JSON/);
  });

  it("throws NeweggApiError carrying the HTTP status on a non-2xx response", async () => {
    const { client } = makeClient("ca", [offersRoute({ error: "forbidden" }, 403)]);
    const error = await client.storefront
      .getOffers({ itemNumber: PARENT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as NeweggApiError).httpStatus).toBe(403);
    expect((error as NeweggApiError).message).toMatch(/HTTP 403/);
  });

  it("throws NeweggApiError when the payload is not an object", async () => {
    const { client } = makeClient("ca", [offersRoute(JSON.stringify("not-an-object"))]);
    await expect(client.storefront.getOffers({ itemNumber: PARENT })).rejects.toBeInstanceOf(
      NeweggApiError,
    );
  });

  it("throws UnsupportedMarketplaceOperationError on the b2b marketplace", async () => {
    const { client, calls } = makeClient("b2b", [offersRoute(MBO_BODY)]);
    await expect(client.storefront.getOffers({ itemNumber: PARENT })).rejects.toBeInstanceOf(
      UnsupportedMarketplaceOperationError,
    );
    expect(calls).toHaveLength(0);
  });
});
