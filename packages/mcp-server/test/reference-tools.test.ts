import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, startHarness } from "./helpers.js";

/** Synthetic fixtures modeled on the official §19 samples; nothing here is real account data. */
const wrapped = (responseBody: unknown) => ({
  NeweggAPIResponse: { IsSuccess: "true", SellerID: "A006", ResponseBody: responseBody },
});

const route = (method: string, pattern: RegExp, body: unknown, status = 200): MockRoute => ({
  method,
  pathPattern: pattern,
  reply: () => ({ status, body }),
});

const STATUS_ROUTE = /sellermgmt\/seller\/accountstatus/;
const INDUSTRY_ROUTE = /sellermgmt\/seller\/industry/;
const SUBCATEGORY_ROUTE = /sellermgmt\/seller\/subcategory\?/;
const PROPERTY_ROUTE = /sellermgmt\/seller\/subcategoryproperty/;
const VALUE_ROUTE = /sellermgmt\/seller\/propertyvalue/;

const manySubcategories = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    IndustryCode: "AP",
    IndustryName: "Apparel",
    SubcategoryID: String(1000 + i),
    SubcategoryName: `Subcategory ${i}`,
    Enabled: i % 2 === 0 ? "1" : "0",
  }));

describe("newegg_seller_status", () => {
  it("returns status, membership and fulfillment centers (US sends version 307)", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MARKETPLACE: "us" }),
      routes: [
        route(
          "GET",
          STATUS_ROUTE,
          wrapped({
            SellerName: "Test_Store",
            Status: "Active",
            Membership: "1",
            FufillmentCenterList: [
              { WarehouseLocation: "USA", WarehouseType: 1, ShippingDestinationList: ["USA"] },
            ],
          }),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_seller_status", {});
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        marketplace: "us",
        sellerName: "Test_Store",
        status: "active",
        membership: "professional",
        fulfillmentCenters: [
          { warehouseLocation: "USA", shippedBy: "newegg", shipToCountries: ["USA"] },
        ],
      });
      expect(harness.calls[0]!.method).toBe("GET");
      expect(harness.calls[0]!.url.searchParams.get("version")).toBe("307");
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown keys and maps upstream errors to a structured tool error", async () => {
    const harness = await startHarness({
      routes: [
        route("GET", STATUS_ROUTE, [{ Code: "CE001", Message: "SellerID cannot be null" }], 400),
      ],
    });
    try {
      expect((await callTool(harness.mcp, "newegg_seller_status", { bogus: 1 })).isError).toBe(
        true,
      );
      expect(harness.calls).toHaveLength(0);
      const res = await callTool(harness.mcp, "newegg_seller_status", {});
      expect(res.isError).toBe(true);
      expect(res.json).toMatchObject({ neweggErrorCode: "CE001", httpStatus: 400 });
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_industries_list", () => {
  it("lists industries and forwards the code filter as industrycode", async () => {
    const harness = await startHarness({
      routes: [
        route(
          "GET",
          INDUSTRY_ROUTE,
          wrapped({ IndustryList: { Industry: { IndustryCode: "AP", IndustryName: "Apparel" } } }),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_industries_list", { industryCode: "AP" });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ industries: [{ code: "AP", name: "Apparel" }] });
      expect(harness.calls[0]!.url.searchParams.get("industrycode")).toBe("AP");
      expect(
        (await callTool(harness.mcp, "newegg_industries_list", { industryCode: "a b" })).isError,
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("surfaces DF008 from an XML error body", async () => {
    const harness = await startHarness({
      routes: [
        route(
          "GET",
          INDUSTRY_ROUTE,
          "<Errors><Error><Code>DF008</Code><Message>Invalid industry code ABC</Message></Error></Errors>",
          400,
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_industries_list", { industryCode: "ABC" });
      expect(res.isError).toBe(true);
      expect(res.json).toMatchObject({ neweggErrorCode: "DF008", httpStatus: 400 });
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_subcategories_list", () => {
  it("forwards filters, and caps rows at limit while reporting the full count", async () => {
    const harness = await startHarness({
      routes: [route("PUT", SUBCATEGORY_ROUTE, wrapped({ SubcategoryList: manySubcategories(5) }))],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_subcategories_list", {
        industryCodes: ["AP"],
        enabled: true,
        limit: 2,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ totalCount: 5, truncated: true });
      expect(res.json.subcategories).toHaveLength(2);
      expect((res.json.subcategories as unknown[])[0]).toEqual({
        industryCode: "AP",
        industryName: "Apparel",
        subcategoryId: 1000,
        subcategoryName: "Subcategory 0",
        enabled: true,
      });
      expect(harness.calls[0]!.method).toBe("PUT");
      expect(harness.calls[0]!.bodyJson).toEqual({
        OperationType: "GetSellerSubcategoryRequest",
        RequestBody: {
          GetItemSubcategory: { IndustryCodeList: { IndustryCode: ["AP"] }, Enabled: "1" },
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("returns everything under the default limit, untruncated", async () => {
    const harness = await startHarness({
      routes: [route("PUT", SUBCATEGORY_ROUTE, wrapped({ SubcategoryList: manySubcategories(3) }))],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_subcategories_list", {});
      expect(res.json).toMatchObject({ totalCount: 3, truncated: false });
      expect(res.json.subcategories).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it("returns a structured error for countryCode on a non-Newegg.com marketplace, without sending", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_subcategories_list", { countryCode: "USA" });
      expect(res.isError).toBe(true);
      expect(res.json).toMatchObject({ errorCode: "unsupported_operation" });
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects bad input at the schema", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      for (const args of [
        { bogus: 1 },
        { subcategoryIds: [0] },
        { countryCode: "us" },
        { limit: 0 },
        { limit: 5000 },
      ]) {
        expect((await callTool(harness.mcp, "newegg_subcategories_list", args)).isError).toBe(true);
      }
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_subcategory_properties", () => {
  it("returns properties with boolean flags", async () => {
    const harness = await startHarness({
      routes: [
        route(
          "PUT",
          PROPERTY_ROUTE,
          wrapped({
            SubcategoryPropertyList: {
              SubcategoryProperty: {
                SubcategoryID: "1045",
                SubcategoryName: "Costumes",
                PropertyName: "Costume_Model",
                IsAdvancedSearch: "1",
                IsGroupBy: "0",
                IsRequired: "1",
              },
            },
          }),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_subcategory_properties", {
        subcategoryId: 1045,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        subcategoryId: 1045,
        totalCount: 1,
        truncated: false,
        properties: [
          {
            subcategoryName: "Costumes",
            propertyName: "Costume_Model",
            isAdvancedSearch: true,
            isGroupBy: false,
            isRequired: true,
          },
        ],
      });
      expect(harness.calls[0]!.bodyJson).toEqual({
        OperationType: "GetSellerSubcategoryPropertyRequest",
        RequestBody: { SubcategoryID: "1045" },
      });
      expect((await callTool(harness.mcp, "newegg_subcategory_properties", {})).isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("surfaces DF009 from a JSON array error body", async () => {
    const harness = await startHarness({
      routes: [
        route(
          "PUT",
          PROPERTY_ROUTE,
          [{ Code: "DF009", Message: "Invalid subcategory ID 99" }],
          400,
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_subcategory_properties", {
        subcategoryId: 99,
      });
      expect(res.isError).toBe(true);
      expect(res.json).toMatchObject({ neweggErrorCode: "DF009" });
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_property_values", () => {
  const valueRows = (values: string[]) =>
    values.map((value) => ({
      SubcategoryID: "1045",
      SubcategoryName: "Costume",
      PropertyName: "Costume_Gender",
      IsAdvancedSearch: "1",
      IsGroupBy: "0",
      IsRequired: "0",
      PropertyValueList: [value],
    }));

  it("merges per-value rows and caps each property's values at limit", async () => {
    const harness = await startHarness({
      routes: [
        route(
          "PUT",
          VALUE_ROUTE,
          wrapped({ PropertyInfoList: valueRows(["Male", "Female", "Unisex"]) }),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_property_values", {
        propertyName: "Costume_Gender",
        subcategoryId: 1045,
        limit: 2,
      });
      expect(res.isError).toBe(false);
      expect(res.json.properties).toEqual([
        {
          subcategoryId: 1045,
          subcategoryName: "Costume",
          propertyName: "Costume_Gender",
          isAdvancedSearch: true,
          isGroupBy: false,
          isRequired: false,
          values: ["Male", "Female"],
          valueCount: 3,
          truncated: true,
        },
      ]);
      expect(res.json).toMatchObject({ totalCount: 1, truncated: false });
      expect(harness.calls[0]!.bodyJson).toEqual({
        OperationType: "GetSellerPropertyValueRequest",
        RequestBody: { SubcategoryID: "1045", PropertyName: "Costume_Gender" },
      });
    } finally {
      await harness.close();
    }
  });

  it("caps the properties array at limit too, reporting totalCount and truncated", async () => {
    const rows = [1001, 1002, 1003].map((id) => ({
      ...valueRows(["Red"])[0]!,
      SubcategoryID: String(id),
    }));
    const harness = await startHarness({
      routes: [route("PUT", VALUE_ROUTE, wrapped({ PropertyInfoList: rows }))],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_property_values", {
        propertyName: "Costume_Gender",
        limit: 2,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ totalCount: 3, truncated: true });
      expect(
        (res.json.properties as Array<{ subcategoryId: number }>).map((p) => p.subcategoryId),
      ).toEqual([1001, 1002]);
      const all = await callTool(harness.mcp, "newegg_property_values", {
        propertyName: "Costume_Gender",
      });
      expect(all.json).toMatchObject({ totalCount: 3, truncated: false });
      expect(all.json.properties).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it("trims the property name before validating and sending", async () => {
    const harness = await startHarness({
      routes: [route("PUT", VALUE_ROUTE, wrapped({ PropertyInfoList: [] }))],
    });
    try {
      const ok = await callTool(harness.mcp, "newegg_property_values", {
        propertyName: "  Costume_Gender  ",
      });
      expect(ok.isError).toBe(false);
      expect(harness.calls[0]!.bodyJson).toMatchObject({
        RequestBody: { PropertyName: "Costume_Gender" },
      });
      const blank = await callTool(harness.mcp, "newegg_property_values", { propertyName: "   " });
      expect(blank.isError).toBe(true);
      expect(harness.calls).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("rejects missing or oversized property names and unknown keys", async () => {
    const harness = await startHarness({ routes: [] });
    try {
      for (const args of [
        {},
        { propertyName: "" },
        { propertyName: "x".repeat(201) },
        { propertyName: "A", extra: 1 },
      ]) {
        expect((await callTool(harness.mcp, "newegg_property_values", args)).isError).toBe(true);
      }
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
