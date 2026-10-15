import { describe, expect, it } from "vitest";
import {
  NeweggApiError,
  UnsupportedMarketplaceOperationError,
  type SubcategoryStatus,
} from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live reads of the seller / category reference endpoints against the REAL Newegg API
 * (contracts §19 - Seller Status Check, Get Industry List, Get Subcategory Status / Properties /
 * Property Values; the subcategory, property and value reads are `PUT` but only read). Shapes are
 * asserted, never account-specific values: the subcategory is discovered at runtime and nothing
 * real is hardcoded. About eight requests in total (Newegg allows 100/hour on the PUT reads).
 */
describe.skipIf(!liveEnabled)("live (read-only): reference reads", () => {
  const client = makeLiveClient();
  let subcategories: SubcategoryStatus[] | undefined;

  const discoverSubcategories = async (): Promise<SubcategoryStatus[]> => {
    if (subcategories === undefined) {
      // The Computer Hardware industry ("CH") is small enough to keep the response light.
      const result = await client.reference.listSubcategories({ industryCodes: ["CH"] });
      subcategories = result.subcategories;
    }
    return subcategories;
  };

  it("getSellerStatus returns the store name and a known status", async () => {
    const status = await client.reference.getSellerStatus();
    expect(status.marketplace).toBe(marketplace());
    expect(status.sellerName).toEqual(expect.any(String));
    expect(status.status).not.toBe("unknown");
    expect(Array.isArray(status.fulfillmentCenters)).toBe(true);
  });

  it("listIndustries returns coded industries and filters by code", async () => {
    const { industries } = await client.reference.listIndustries();
    expect(industries.length).toBeGreaterThan(0);
    for (const industry of industries) expect(industry.code).toMatch(/^[A-Z0-9]+$/);

    const first = industries[0];
    if (first === undefined) return;
    const filtered = await client.reference.listIndustries({ industryCode: first.code });
    expect(filtered.industries.map((i) => i.code)).toEqual([first.code]);
  });

  it("listSubcategories filters by industry and returns numeric ids", async () => {
    const list = await discoverSubcategories();
    expect(list.length).toBeGreaterThan(0);
    for (const subcategory of list) {
      expect(Number.isInteger(subcategory.subcategoryId)).toBe(true);
      expect(subcategory.industryCode).toBe("CH");
      expect(typeof subcategory.enabled).toBe("boolean");
    }
  });

  it("listSubcategories by id returns exactly the requested subcategories", async () => {
    const list = await discoverSubcategories();
    const ids = list.slice(0, 2).map((s) => s.subcategoryId);
    if (ids.length === 0) return;
    const result = await client.reference.listSubcategories({ subcategoryIds: ids });
    expect(result.subcategories.map((s) => s.subcategoryId).sort()).toEqual([...ids].sort());
  });

  it("countryCode (Newegg.com only) is rejected before sending on B2B/CAN", async (ctx) => {
    if (marketplace() === "us") {
      ctx.skip();
      return;
    }
    await expect(client.reference.listSubcategories({ countryCode: "USA" })).rejects.toBeInstanceOf(
      UnsupportedMarketplaceOperationError,
    );
  });

  it("listSubcategoryProperties then listPropertyValues return property and value lists", async () => {
    const list = await discoverSubcategories();
    const subcategory = list.find((s) => s.enabled) ?? list[0];
    if (subcategory === undefined) return;

    const { properties, subcategoryId } = await client.reference.listSubcategoryProperties(
      subcategory.subcategoryId,
    );
    expect(subcategoryId).toBe(subcategory.subcategoryId);
    expect(properties.length).toBeGreaterThan(0);
    for (const property of properties) {
      expect(property.propertyName).not.toBe("");
      expect(typeof property.isRequired).toBe("boolean");
      expect(typeof property.isGroupBy).toBe("boolean");
      expect(typeof property.isAdvancedSearch).toBe("boolean");
    }

    const [first] = properties;
    if (first === undefined) return;
    const values = await client.reference.listPropertyValues({
      subcategoryId: subcategory.subcategoryId,
      propertyName: first.propertyName,
    });
    expect(values.properties.length).toBeGreaterThanOrEqual(1);
    const [entry] = values.properties;
    expect(entry?.propertyName).toBe(first.propertyName);
    expect(Array.isArray(entry?.values)).toBe(true);
  });

  it("an unknown subcategory id surfaces as a typed API error (DF009)", async () => {
    const failure = await client.reference
      .listSubcategoryProperties(999_999_999)
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NeweggApiError);
    expect((failure as NeweggApiError).neweggErrorCode).toBe("DF009");
  });
});
