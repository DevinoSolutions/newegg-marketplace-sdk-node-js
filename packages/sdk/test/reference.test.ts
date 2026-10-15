import { describe, expect, it } from "vitest";
import {
  NeweggApiError,
  NeweggRateLimitError,
  NeweggValidationError,
  UnsupportedMarketplaceOperationError,
  type NeweggMarketplace,
} from "../src/index.js";
import type { MockRoute } from "../src/testing/index.js";
import { makeClient, paths } from "./helpers.js";

/**
 * Seller / category reference read fixtures modeled on the official §19 samples. Identifiers,
 * names and categories are fictional placeholders (the repo is public).
 */
const route = (
  method: string,
  pathPattern: RegExp,
  reply: () => { status: number; body?: unknown },
): MockRoute[] => [{ method, pathPattern, reply }];

const wrapped = (responseBody: unknown, operationType: string) => ({
  NeweggAPIResponse: {
    IsSuccess: "true",
    OperationType: operationType,
    SellerID: "A006",
    ResponseBody: responseBody,
  },
});

const CENTERS = [
  { WarehouseLocation: "TUR", WarehouseType: 0, ShippingDestinationList: ["TUR", "USA"] },
  { WarehouseLocation: "USA", WarehouseType: 1, ShippingDestinationList: ["AUS", "USA", "SGP"] },
];

describe("reference.getSellerStatus", () => {
  it("sends a GET with sellerid + version=307 on Newegg.com and maps the JSON sample", async () => {
    const { client, calls } = makeClient(
      "us",
      route("GET", paths.sellerStatus, () => ({
        status: 200,
        body: {
          IsSuccess: true,
          OperationType: "GetSellerAccountStatusResponse",
          SellerID: "A006",
          ResponseBody: {
            Membership: 0,
            FufillmentCenterList: CENTERS,
            SellerName: "Test_Store",
            Status: "Active",
          },
        },
      })),
    );
    const status = await client.reference.getSellerStatus();
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe("/marketplace/sellermgmt/seller/accountstatus");
    expect(call.url.searchParams.get("sellerid")).toBe("A006");
    expect(call.url.searchParams.get("version")).toBe("307");
    expect(call.bodyText ?? "").toBe("");
    expect(status).toMatchObject({
      marketplace: "us",
      sellerName: "Test_Store",
      status: "active",
      statusText: "Active",
      membership: "nonElite",
      fulfillmentCenters: [
        { warehouseLocation: "TUR", shippedBy: "seller", shipToCountries: ["TUR", "USA"] },
        { warehouseLocation: "USA", shippedBy: "newegg", shipToCountries: ["AUS", "USA", "SGP"] },
      ],
    });
  });

  it("reads the XML-converted shape: single center object, wrapped destinations, string numbers", async () => {
    const { client } = makeClient(
      "us",
      route("GET", paths.sellerStatus, () => ({
        status: 200,
        body: wrapped(
          {
            SellerName: "Test_Store",
            Status: "Suspended",
            Membership: "2",
            FufillmentCenterList: {
              FufillmentCenter: {
                WarehouseLocation: "USA",
                WarehouseType: "1",
                ShippingDestinationList: { ShipToCountry: "CAN" },
              },
            },
          },
          "GetSellerAccountStatusResponse",
        ),
      })),
    );
    const status = await client.reference.getSellerStatus();
    expect(status.status).toBe("suspended");
    expect(status.membership).toBe("enterprise");
    expect(status.fulfillmentCenters).toEqual([
      { warehouseLocation: "USA", shippedBy: "newegg", shipToCountries: ["CAN"] },
    ]);
  });

  it.each([
    ["b2b", "/marketplace/b2b/sellermgmt/seller/accountstatus"],
    ["ca", "/marketplace/can/sellermgmt/seller/accountstatus"],
  ] as const)(
    "%s sends no version and tolerates a response without membership or centers",
    async (marketplace, pathname) => {
      const { client, calls } = makeClient(
        marketplace,
        route("GET", paths.sellerStatus, () => ({
          status: 200,
          body: wrapped(
            { SellerName: "Test_Store", Status: "Active" },
            "GetSellerAccountStatusResponse",
          ),
        })),
      );
      const status = await client.reference.getSellerStatus();
      expect(calls[0]!.url.pathname).toBe(pathname);
      expect(calls[0]!.url.searchParams.has("version")).toBe(false);
      expect(status).toMatchObject({ marketplace, status: "active", fulfillmentCenters: [] });
      expect(status.membership).toBeUndefined();
    },
  );

  it("degrades unknown status text and membership codes to 'unknown' instead of throwing", async () => {
    const { client } = makeClient(
      "us",
      route("GET", paths.sellerStatus, () => ({
        status: 200,
        body: wrapped({ Status: "Frozen", Membership: "9" }, "GetSellerAccountStatusResponse"),
      })),
    );
    const status = await client.reference.getSellerStatus();
    expect(status).toMatchObject({
      status: "unknown",
      statusText: "Frozen",
      membership: "unknown",
    });
  });

  it("includes the raw payload only when asked", async () => {
    const body = wrapped({ Status: "Active" }, "GetSellerAccountStatusResponse");
    const { client } = makeClient(
      "ca",
      route("GET", paths.sellerStatus, () => ({ status: 200, body })),
    );
    expect((await client.reference.getSellerStatus()).raw).toBeUndefined();
    expect((await client.reference.getSellerStatus({ includeRaw: true })).raw).toEqual(body);
  });

  it("throws NeweggApiError when the envelope says IsSuccess=false", async () => {
    const { client } = makeClient(
      "ca",
      route("GET", paths.sellerStatus, () => ({
        status: 200,
        body: { NeweggAPIResponse: { IsSuccess: "false", Memo: "nope" } },
      })),
    );
    await expect(client.reference.getSellerStatus()).rejects.toBeInstanceOf(NeweggApiError);
  });
});

describe("reference.listIndustries", () => {
  const TWO = [
    { IndustryCode: "AP", IndustryName: "Apparel" },
    { IndustryCode: "AL", IndustryName: "Appliance" },
  ];

  it("sends a GET without industrycode and maps an array list", async () => {
    const { client, calls } = makeClient(
      "ca",
      route("GET", paths.industry, () => ({
        status: 200,
        body: {
          IsSuccess: "true",
          OperationType: "GetSellerIndustryResponse",
          SellerID: "A006",
          ResponseBody: { IndustryList: TWO },
        },
      })),
    );
    const result = await client.reference.listIndustries();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/marketplace/can/sellermgmt/seller/industry");
    expect(calls[0]!.url.searchParams.has("industrycode")).toBe(false);
    expect(result.industries).toEqual([
      { code: "AP", name: "Apparel" },
      { code: "AL", name: "Appliance" },
    ]);
  });

  it("reads an XML-style wrapper holding a single object, and adds industrycode when filtering", async () => {
    const { client, calls } = makeClient(
      "us",
      route("GET", paths.industry, () => ({
        status: 200,
        body: wrapped({ IndustryList: { Industry: TWO[0] } }, "GetSellerIndustryResponse"),
      })),
    );
    const result = await client.reference.listIndustries({ industryCode: "AP" });
    expect(calls[0]!.url.pathname).toBe("/marketplace/sellermgmt/seller/industry");
    expect(calls[0]!.url.searchParams.get("industrycode")).toBe("AP");
    expect(result.industries).toEqual([{ code: "AP", name: "Apparel" }]);
  });

  it.each([[""], [null], [{ Industry: "" }], [[]]])(
    "treats an empty IndustryList (%j) as no industries, never a phantom row",
    async (empty) => {
      const { client } = makeClient(
        "b2b",
        route("GET", paths.industry, () => ({
          status: 200,
          body: wrapped({ IndustryList: empty }, "GetSellerIndustryResponse"),
        })),
      );
      expect((await client.reference.listIndustries()).industries).toEqual([]);
    },
  );

  it("rejects a malformed industry code before sending", async () => {
    const { client, calls } = makeClient("ca", []);
    await expect(client.reference.listIndustries({ industryCode: "A B" })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["JSON array", JSON.stringify([{ Code: "DF008", Message: "Invalid industry code ABC" }])],
    [
      "XML",
      '<?xml version="1.0" encoding="utf-8"?><Errors><Error><Code>DF008</Code><Message>Invalid industry code ABC</Message></Error></Errors>',
    ],
    ["JSON object", JSON.stringify({ Code: "DF008", Message: "Invalid industry code ABC" })],
  ])("maps a 400 %s error body to NeweggApiError with the Newegg code", async (_label, body) => {
    const { client } = makeClient(
      "ca",
      route("GET", paths.industry, () => ({ status: 400, body })),
    );
    await expect(client.reference.listIndustries({ industryCode: "ABC" })).rejects.toMatchObject({
      name: "NeweggApiError",
      neweggErrorCode: "DF008",
      httpStatus: 400,
    });
  });

  it("maps a plain-text error body without throwing a parse error", async () => {
    const { client } = makeClient(
      "ca",
      route("GET", paths.industry, () => ({ status: 400, body: "bad request" })),
    );
    await expect(client.reference.listIndustries()).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("surfaces a 200 whose body is an error list instead of returning an empty result", async () => {
    const { client } = makeClient(
      "ca",
      route("GET", paths.industry, () => ({
        status: 200,
        body: [{ Code: "DF008", Message: "Invalid industry code ABC" }],
      })),
    );
    await expect(client.reference.listIndustries()).rejects.toMatchObject({
      name: "NeweggApiError",
      neweggErrorCode: "DF008",
    });
  });

  it("maps HTTP 429 to NeweggRateLimitError", async () => {
    const { client } = makeClient(
      "ca",
      route("GET", paths.industry, () => ({
        status: 429,
        body: JSON.stringify([{ Code: "429", Message: "too many" }]),
      })),
      { retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } },
    );
    await expect(client.reference.listIndustries()).rejects.toBeInstanceOf(NeweggRateLimitError);
  });
});

describe("reference.listSubcategories", () => {
  const ROWS = [
    {
      IndustryCode: "AP",
      IndustryName: "Apparel",
      SubcategoryID: "1508",
      SubcategoryName: "Belts & Suspenders",
      Enabled: "1",
    },
    {
      IndustryCode: "AP",
      IndustryName: "Apparel",
      SubcategoryID: "153",
      SubcategoryName: "Buckles",
      Enabled: "0",
    },
  ];
  const reply =
    (list: unknown, extra: Record<string, unknown> = {}) =>
    () => ({
      status: 200,
      body: wrapped({ ...extra, SubcategoryList: list }, "GetSellerSubcategoryResponse"),
    });

  it("PUTs the nested GetItemSubcategory body (string values) and maps the rows", async () => {
    const { client, calls } = makeClient("ca", route("PUT", paths.subcategoryStatus, reply(ROWS)));
    const result = await client.reference.listSubcategories({
      subcategoryIds: [397, 1508],
      industryCodes: ["CH"],
      enabled: true,
    });
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/marketplace/can/sellermgmt/seller/subcategory");
    expect(call.url.searchParams.get("sellerid")).toBe("A006");
    expect(call.bodyJson).toEqual({
      OperationType: "GetSellerSubcategoryRequest",
      RequestBody: {
        GetItemSubcategory: {
          SubcategoryIDList: { SubcategoryID: ["397", "1508"] },
          IndustryCodeList: { IndustryCode: ["CH"] },
          Enabled: "1",
        },
      },
    });
    expect(result.countryCode).toBeUndefined();
    expect(result.subcategories).toEqual([
      {
        industryCode: "AP",
        industryName: "Apparel",
        subcategoryId: 1508,
        subcategoryName: "Belts & Suspenders",
        enabled: true,
      },
      {
        industryCode: "AP",
        industryName: "Apparel",
        subcategoryId: 153,
        subcategoryName: "Buckles",
        enabled: false,
      },
    ]);
  });

  it("sends an empty filter object when no criteria are given and Enabled 0 for false", async () => {
    const { client, calls } = makeClient("us", route("PUT", paths.subcategoryStatus, reply([])));
    await client.reference.listSubcategories();
    await client.reference.listSubcategories({ enabled: false });
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetSellerSubcategoryRequest",
      RequestBody: { GetItemSubcategory: {} },
    });
    expect(calls[1]!.bodyJson).toMatchObject({
      RequestBody: { GetItemSubcategory: { Enabled: "0" } },
    });
  });

  it("leaves enabled undefined when Enabled is missing or garbled, never assuming false", async () => {
    const rows = [
      { SubcategoryID: "1", SubcategoryName: "A", Enabled: "1" },
      { SubcategoryID: "2", SubcategoryName: "B" },
      { SubcategoryID: "3", SubcategoryName: "C", Enabled: "maybe" },
      { SubcategoryID: "4", SubcategoryName: "D", Enabled: "0" },
    ];
    const { client } = makeClient("ca", route("PUT", paths.subcategoryStatus, reply(rows)));
    const result = await client.reference.listSubcategories();
    expect(result.subcategories.map((s) => s.enabled)).toEqual([true, undefined, undefined, false]);
  });

  it("reads a single-object XML-style wrapper", async () => {
    const { client } = makeClient(
      "ca",
      route("PUT", paths.subcategoryStatus, reply({ Subcategory: ROWS[0] })),
    );
    const result = await client.reference.listSubcategories();
    expect(result.subcategories.map((s) => s.subcategoryId)).toEqual([1508]);
  });

  it.each([[""], [null], [{ Subcategory: "" }]])(
    "treats an empty SubcategoryList (%j) as no subcategories",
    async (empty) => {
      const { client } = makeClient("ca", route("PUT", paths.subcategoryStatus, reply(empty)));
      expect((await client.reference.listSubcategories()).subcategories).toEqual([]);
    },
  );

  it("uses the V2 international path with CountryCode on Newegg.com", async () => {
    const { client, calls } = makeClient(
      "us",
      route("PUT", paths.subcategoryStatusIntl, reply(ROWS, { CountryCode: "USA" })),
    );
    const result = await client.reference.listSubcategories({ countryCode: "USA", enabled: true });
    expect(calls[0]!.url.pathname).toBe("/marketplace/sellermgmt/seller/subcategory/V2");
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetSellerSubcategoryRequest",
      RequestBody: { CountryCode: "USA", GetItemSubcategory: { Enabled: "1" } },
    });
    expect(result.countryCode).toBe("USA");
    expect(result.subcategories).toHaveLength(2);
  });

  it.each(["b2b", "ca"] as const)(
    "%s rejects countryCode with UnsupportedMarketplaceOperationError before sending",
    async (marketplace) => {
      const { client, calls } = makeClient(marketplace, []);
      await expect(
        client.reference.listSubcategories({ countryCode: "USA" }),
      ).rejects.toBeInstanceOf(UnsupportedMarketplaceOperationError);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    [{ subcategoryIds: [0] }],
    [{ subcategoryIds: [1.5] }],
    [{ industryCodes: ["bad code"] }],
    [{ countryCode: "usa" }],
    [{ enabled: "yes" as unknown as boolean }],
  ])("rejects invalid input %j before sending", async (input) => {
    const { client, calls } = makeClient("us", []);
    await expect(client.reference.listSubcategories(input)).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("surfaces a Newegg error body (DF008 as XML)", async () => {
    const { client } = makeClient(
      "ca",
      route("PUT", paths.subcategoryStatus, () => ({
        status: 400,
        body: "<Errors><Error><Code>DF008</Code><Message>Invalid industry code ABC</Message></Error></Errors>",
      })),
    );
    await expect(
      client.reference.listSubcategories({ industryCodes: ["ABC"] }),
    ).rejects.toMatchObject({
      neweggErrorCode: "DF008",
    });
  });
});

describe("reference.listSubcategoryProperties", () => {
  const PROPS = [
    {
      SubcategoryID: "1045",
      SubcategoryName: "Costumes",
      PropertyName: "Costume_Brand",
      IsAdvancedSearch: "0",
      IsGroupBy: "0",
      IsRequired: "0",
    },
    {
      SubcategoryID: "1045",
      SubcategoryName: "Costumes",
      PropertyName: "Costume_Model",
      IsAdvancedSearch: "1",
      IsGroupBy: "1",
      IsRequired: "1",
    },
  ];

  it("PUTs the subcategory id as a string and maps flags to booleans", async () => {
    const { client, calls } = makeClient(
      "ca",
      route("PUT", paths.subcategoryProperty, () => ({
        status: 200,
        body: wrapped({ SubcategoryPropertyList: PROPS }, "GetSellerSubcategoryPropertyResponse"),
      })),
    );
    const result = await client.reference.listSubcategoryProperties(1045);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/marketplace/can/sellermgmt/seller/subcategoryproperty");
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetSellerSubcategoryPropertyRequest",
      RequestBody: { SubcategoryID: "1045" },
    });
    expect(result.subcategoryId).toBe(1045);
    expect(result.properties).toEqual([
      {
        subcategoryId: 1045,
        subcategoryName: "Costumes",
        propertyName: "Costume_Brand",
        isAdvancedSearch: false,
        isGroupBy: false,
        isRequired: false,
      },
      {
        subcategoryId: 1045,
        subcategoryName: "Costumes",
        propertyName: "Costume_Model",
        isAdvancedSearch: true,
        isGroupBy: true,
        isRequired: true,
      },
    ]);
  });

  it("reads a single-object wrapper, and an empty list as no properties", async () => {
    let body: unknown = wrapped(
      { SubcategoryPropertyList: { SubcategoryProperty: PROPS[1] } },
      "GetSellerSubcategoryPropertyResponse",
    );
    const { client } = makeClient(
      "us",
      route("PUT", paths.subcategoryProperty, () => ({ status: 200, body })),
    );
    expect((await client.reference.listSubcategoryProperties(1045)).properties).toHaveLength(1);
    body = wrapped({ SubcategoryPropertyList: "" }, "GetSellerSubcategoryPropertyResponse");
    expect((await client.reference.listSubcategoryProperties(1045)).properties).toEqual([]);
  });

  it.each([0, -3, 1.2, Number.NaN])("rejects subcategoryId %s before sending", async (id) => {
    const { client, calls } = makeClient("ca", []);
    await expect(client.reference.listSubcategoryProperties(id)).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("surfaces DF009 (invalid subcategory id) from a JSON-array error body", async () => {
    const { client } = makeClient(
      "ca",
      route("PUT", paths.subcategoryProperty, () => ({
        status: 400,
        body: JSON.stringify([{ Code: "DF009", Message: "Invalid subcategory ID 99999" }]),
      })),
    );
    await expect(client.reference.listSubcategoryProperties(99999)).rejects.toMatchObject({
      neweggErrorCode: "DF009",
    });
  });
});

describe("reference.listPropertyValues", () => {
  const valueRow = (value: string, name = "Costume_Gender") => ({
    SubcategoryID: "1045",
    SubcategoryName: "Costume",
    PropertyName: name,
    IsAdvancedSearch: "1",
    IsGroupBy: "0",
    IsRequired: "0",
    PropertyValueList: [value],
  });

  it("merges the one-value-per-row sample shape into one entry per property", async () => {
    const { client, calls } = makeClient(
      "ca",
      route("PUT", paths.propertyValue, () => ({
        status: 200,
        body: wrapped(
          {
            PropertyInfoList: [
              valueRow("Male"),
              valueRow("Female"),
              valueRow("Male"),
              valueRow("Unisex"),
            ],
          },
          "GetSellerPropertyValueResponse",
        ),
      })),
    );
    const result = await client.reference.listPropertyValues({
      propertyName: " Costume_Gender ",
      subcategoryId: 1045,
    });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/marketplace/can/sellermgmt/seller/propertyvalue");
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetSellerPropertyValueRequest",
      RequestBody: { SubcategoryID: "1045", PropertyName: "Costume_Gender" },
    });
    expect(result.properties).toEqual([
      {
        subcategoryId: 1045,
        subcategoryName: "Costume",
        propertyName: "Costume_Gender",
        isAdvancedSearch: true,
        isGroupBy: false,
        isRequired: false,
        values: ["Male", "Female", "Unisex"],
      },
    ]);
  });

  it("keeps the same property in different subcategories separate and reads XML-style wrappers", async () => {
    const other = {
      ...valueRow("Red"),
      SubcategoryID: "2000",
      PropertyValueList: { PropertyValue: ["Red", "Blue"] },
    };
    const { client, calls } = makeClient(
      "us",
      route("PUT", paths.propertyValue, () => ({
        status: 200,
        body: wrapped(
          { PropertyInfoList: { PropertyInfo: [valueRow("Male"), other] } },
          "GetSellerPropertyValueResponse",
        ),
      })),
    );
    const result = await client.reference.listPropertyValues({ propertyName: "Costume_Gender" });
    expect(calls[0]!.bodyJson).toEqual({
      OperationType: "GetSellerPropertyValueRequest",
      RequestBody: { PropertyName: "Costume_Gender" },
    });
    expect(result.properties.map((p) => [p.subcategoryId, p.values])).toEqual([
      [1045, ["Male"]],
      [2000, ["Red", "Blue"]],
    ]);
  });

  it("returns no properties for an empty list and survives a missing value list", async () => {
    let body: unknown = wrapped({ PropertyInfoList: "" }, "GetSellerPropertyValueResponse");
    const { client } = makeClient(
      "ca",
      route("PUT", paths.propertyValue, () => ({ status: 200, body })),
    );
    expect((await client.reference.listPropertyValues({ propertyName: "X" })).properties).toEqual(
      [],
    );
    body = wrapped(
      { PropertyInfoList: [{ SubcategoryID: "1", PropertyName: "Free_Text" }] },
      "GetSellerPropertyValueResponse",
    );
    const result = await client.reference.listPropertyValues({ propertyName: "Free_Text" });
    expect(result.properties).toMatchObject([{ propertyName: "Free_Text", values: [] }]);
  });

  it.each([
    [{ propertyName: "" }],
    [{ propertyName: "   " }],
    [{ propertyName: "a\u0000b" }],
    [{ propertyName: "x".repeat(201) }],
    [{ propertyName: "ok", subcategoryId: 0 }],
  ])("rejects invalid input %j before sending", async (input) => {
    const { client, calls } = makeClient("ca", []);
    await expect(client.reference.listPropertyValues(input)).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it.each(["us", "b2b", "ca"] as NeweggMarketplace[])(
    "%s uses its own path prefix",
    async (marketplace) => {
      const prefix = { us: "", b2b: "b2b/", ca: "can/" }[marketplace];
      const { client, calls } = makeClient(
        marketplace,
        route("PUT", paths.propertyValue, () => ({
          status: 200,
          body: wrapped({ PropertyInfoList: [] }, "GetSellerPropertyValueResponse"),
        })),
      );
      await client.reference.listPropertyValues({ propertyName: "X" });
      expect(calls[0]!.url.pathname).toBe(`/marketplace/${prefix}sellermgmt/seller/propertyvalue`);
    },
  );
});
