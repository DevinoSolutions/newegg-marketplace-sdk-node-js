import { describe, expect, it } from "vitest";
import {
  NeweggApiError,
  NeweggValidationError,
  UnsupportedMarketplaceOperationError,
} from "../src/index.js";
import type { MockRoute } from "../src/testing/index.js";
import { makeClient } from "./helpers.js";

/**
 * Sponsored Ads read fixtures modeled on the official §25 samples. Identifiers, names and item
 * numbers are fictional placeholders (the repo is public).
 */
const ADS = "/marketplace/sponsoredmgmt/campaign";

const route = (pathSuffix: string, body: unknown, status = 200): MockRoute[] => [
  {
    method: "POST",
    pathPattern: new RegExp(`^${ADS}${pathSuffix}\\?`),
    reply: () => ({ status, body }),
  },
];

const ok = (rows: unknown, extra: Record<string, unknown> = {}, bizCode = "025") => ({
  header: [{ msg: "success", bizCode }],
  rows,
  totalRows: Array.isArray(rows) ? rows.length : 0,
  ...extra,
});

const METRICS = {
  spend: 12.5,
  sales: 100,
  acos: 0.125,
  impressions: 1000,
  clicks: 50,
  ctr: 0.05,
  orders: 4,
  cr: 0.08,
  cpc: 0.25,
};

describe("ads.listCampaigns", () => {
  it("POSTs the camelCase body to campaign/search and maps the sample", async () => {
    const { client, calls } = makeClient(
      "us",
      route(
        "/search",
        ok([
          {
            campaignNumber: "1000001",
            campaignName: "Example campaign",
            countryCode: "USA",
            type: 0,
            activeStatus: "Active",
            status: "Delivering",
            startDate: "2022-05-05 00:00:00",
            endDate: null,
            budget: "3000.0",
            dailyBudget: 100,
            groupCount: 1,
            inDate: "Wed May 04 03:57:04 PDT 2022",
            inUser: "11111111",
            displayType: "0",
            declineReason: null,
            costModel: 0,
            LastEditDate: "Fri May 27 18:24:44 PDT 2022",
          },
        ]),
      ),
    );
    const result = await client.ads.listCampaigns({
      keyword: " 1000001 ",
      searchBy: "number",
      activeStatus: "active",
      fromDate: "2022-06-01",
      toDate: "2022-07-01",
      page: 2,
      pageSize: 20,
      sortField: "inDate",
      sortOrder: "asc",
    });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe(`${ADS}/search`);
    expect(call.url.searchParams.get("sellerid")).toBe("A006");
    expect(call.bodyJson).toEqual({
      sellerId: "A006",
      countryCode: null,
      searchKeywordType: "CAMPAIGN_NUM",
      keyword: "1000001",
      type: null,
      sponsorType: null,
      displayType: null,
      activeStatus: "Active",
      fromDate: "2022-06-01",
      toDate: "2022-07-01",
      pageInfo: { pageIndex: 2, pageSize: 20, sortField: "inDate", sortType: "Asc" },
    });
    expect(result).toMatchObject({
      marketplace: "us",
      totalRows: 1,
      page: 2,
      pageSize: 20,
      message: "success",
      bizCode: "025",
    });
    expect(result.rows[0]).toEqual({
      campaignNumber: 1000001,
      name: "Example campaign",
      countryCode: "USA",
      type: 0,
      activeStatus: "Active",
      status: "Delivering",
      startDate: "2022-05-05 00:00:00",
      endDate: undefined,
      budget: 3000,
      dailyBudget: 100,
      groupCount: 1,
      createdAt: "Wed May 04 03:57:04 PDT 2022",
      lastEditedAt: "Fri May 27 18:24:44 PDT 2022",
      displayType: "0",
      declineReason: undefined,
      costModel: 0,
    });
  });

  it("defaults to page 1 / 100 rows, a name filter, and Date bounds as Pacific days", async () => {
    const { client, calls } = makeClient("us", route("/search", ok([])));
    const result = await client.ads.listCampaigns({
      keyword: "spring",
      fromDate: new Date("2026-03-02T18:00:00Z"),
    });
    expect(calls[0]?.bodyJson).toMatchObject({
      searchKeywordType: "CAMPAIGN_NAME",
      keyword: "spring",
      fromDate: "2026-03-02",
      toDate: null,
      pageInfo: { pageIndex: 1, pageSize: 100, sortField: null, sortType: null },
    });
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it("treats an empty-string rows member as no rows and a single object as one row", async () => {
    const empty = makeClient("us", route("/search", { header: [], rows: "", totalRows: 0 }));
    expect((await empty.client.ads.listCampaigns()).rows).toEqual([]);
    const single = makeClient(
      "us",
      route("/search", { rows: { campaignNumber: 7, campaignName: "One" }, totalRows: "1" }),
    );
    const page = await single.client.ads.listCampaigns();
    expect(page.rows).toHaveLength(1);
    expect(page.totalRows).toBe(1);
  });

  it("drops rows without an identifier and exposes the sanitized raw payload on request", async () => {
    const { client } = makeClient("us", route("/search", ok([{ campaignName: "no id" }])));
    const result = await client.ads.listCampaigns({}, { includeRaw: true });
    expect(result.rows).toEqual([]);
    expect(result.raw).toBeDefined();
  });

  it("rejects bad input before sending", async () => {
    const { client, calls } = makeClient("us", route("/search", ok([])));
    await expect(client.ads.listCampaigns({ pageSize: 101 })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    await expect(
      client.ads.listCampaigns({ keyword: "abc", searchBy: "number" }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    await expect(client.ads.listCampaigns({ fromDate: "06/01/2022" })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    await expect(client.ads.listCampaigns({ countryCode: "us" })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("is rejected before sending on b2b", async () => {
    const { client, calls } = makeClient("b2b", route("/search", ok([])));
    await expect(client.ads.listCampaigns()).rejects.toBeInstanceOf(
      UnsupportedMarketplaceOperationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("sends to the can/ prefix on ca and parses an empty page", async () => {
    const { client, calls } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: new RegExp(`^/marketplace/can/sponsoredmgmt/campaign/search\?`),
        reply: () => ({ status: 200, body: ok([]) }),
      },
    ]);
    const page = await client.ads.listCampaigns({ pageSize: 5 });
    expect(page.marketplace).toBe("ca");
    expect(page.rows).toEqual([]);
    expect(page.totalRows).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("turns a 200 without rows into a NeweggApiError carrying the bizCode", async () => {
    const { client } = makeClient(
      "us",
      route("/search", { header: [{ msg: "seller not enrolled", bizCode: "403" }] }),
    );
    await expect(client.ads.listCampaigns()).rejects.toMatchObject({
      name: NeweggApiError.name,
      neweggErrorCode: "403",
    });
  });

  it("turns a bare error list into a NeweggApiError", async () => {
    const { client } = makeClient("us", route("/search", [{ Code: "CT001", Message: "bad" }]));
    await expect(client.ads.listCampaigns()).rejects.toMatchObject({ neweggErrorCode: "CT001" });
  });
});

describe("ads.listGroups / listProducts", () => {
  it("listGroups sends the group search body and maps the group row", async () => {
    const { client, calls } = makeClient(
      "us",
      route(
        "/group/search",
        ok([
          {
            campaignNumber: 1000001,
            campaignName: "Example campaign",
            groupNumber: 1000002,
            groupName: "Example group",
            countryCode: "USA",
            defaultBid: 0.89,
            offSiteBid: null,
            type: 0,
            suggBid: 0.5,
            suggBidLowest: 0.3,
            suggBidMost: 0.9,
            keywordSize: 12,
            productSize: 2,
            productList: ["9SIXXXXXXXXXXX1", "9SIXXXXXXXXXXX2"],
            activeStatus: "Active",
            status: "Delivering",
            inDate: "Sat Feb 19 15:46:26 PST 2022",
            landingPageType: 0,
            costModel: 1,
          },
        ]),
      ),
    );
    const result = await client.ads.listGroups({
      campaignNumber: 1000001,
      keyword: "1000002, 1000003",
      searchBy: "number",
    });
    expect(calls[0]?.bodyJson).toEqual({
      sellerId: "A006",
      countryCode: null,
      campaignNumber: 1000001,
      searchKeywordType: "GROUP_NUM",
      keyword: "1000002,1000003",
      activeStatus: null,
      fromDate: null,
      toDate: null,
      pageInfo: { pageIndex: 1, pageSize: 100, sortField: null, sortType: null },
    });
    expect(result.rows[0]).toMatchObject({
      campaignNumber: 1000001,
      groupNumber: 1000002,
      groupName: "Example group",
      defaultBid: 0.89,
      suggBid: 0.5,
      keywordCount: 12,
      productCount: 2,
      productItemNumbers: ["9SIXXXXXXXXXXX1", "9SIXXXXXXXXXXX2"],
      costModel: 1,
    });
    await expect(client.ads.listGroups({ campaignNumber: 0 })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
  });

  it("listProducts defaults the country to USA and sends the countries list", async () => {
    const { client, calls } = makeClient(
      "us",
      route(
        "/product/search",
        ok([
          {
            campaignNumber: 1000001,
            groupNumber: 1000002,
            itemNumber: "9SIXXXXXXXXXXX1",
            itemTitle: "Example item",
            sellingPrice: "19.99",
            itemStatus: "ENABLED",
            activeStatus: "Active",
            status: "Delivering",
          },
          { itemTitle: "no item number" },
        ]),
      ),
    );
    const result = await client.ads.listProducts({ campaignNumber: 1000001, groupNumber: 1000002 });
    expect(calls[0]?.bodyJson).toMatchObject({
      countryCode: "USA",
      countries: ["USA"],
      campaignNumber: 1000001,
      groupNumber: 1000002,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      itemNumber: "9SIXXXXXXXXXXX1",
      sellingPrice: 19.99,
      itemStatus: "ENABLED",
    });
  });
});

describe("ads keywords", () => {
  it("listKeywords sends KEYWORD search only when a keyword is given", async () => {
    const { client, calls } = makeClient(
      "us",
      route(
        "/keyword/search",
        ok([
          {
            campaignNumber: 0,
            groupNumber: 0,
            keyword: "usb hub",
            matchType: 6,
            normalizedKeyword: "hub|usb",
            keywordUrl: "https://www.newegg.com/p/pl?d=usb hub",
            bid: "0.35",
            competition: "Low",
            searchVolume: "1000+",
            activeStatus: "Active",
            status: "Delivering",
          },
        ]),
      ),
    );
    const none = await client.ads.listKeywords({ campaignNumber: 1000001, groupNumber: 1000002 });
    expect(calls[0]?.bodyJson).toMatchObject({
      campaignNumber: 1000001,
      groupNumber: 1000002,
      searchKeywordType: null,
      keyword: null,
      pageInfo: { pageIndex: 1, pageSize: 100 },
    });
    expect(none.rows[0]).toMatchObject({ keyword: "usb hub", matchType: 6, bid: 0.35 });
    await client.ads.listKeywords({ campaignNumber: 1000001, keyword: "usb" });
    expect(calls[1]?.bodyJson).toMatchObject({
      searchKeywordType: "KEYWORD",
      keyword: "usb",
      groupNumber: null,
    });
    await expect(
      client.ads.listKeywords({ campaignNumber: 1000001, pageSize: 10_000_000 }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
  });

  it("listNegativeKeywords maps status filters and rows", async () => {
    const { client, calls } = makeClient(
      "us",
      route(
        "/negativekeyword/search",
        ok([
          {
            transactionNumber: 5,
            keyword: "free",
            formatKeyword: "free",
            keywordType: 6,
            status: 1,
          },
        ]),
      ),
    );
    const result = await client.ads.listNegativeKeywords({
      campaignNumber: 1000001,
      groupNumber: 1000002,
      keyword: "free",
      active: false,
    });
    expect(calls[0]?.bodyJson).toMatchObject({
      keyword: "free",
      searchKeywordType: "NEGATIVE_NAME",
      status: 0,
    });
    expect(result.rows[0]).toEqual({
      transactionNumber: 5,
      keyword: "free",
      formatKeyword: "free",
      keywordType: 6,
      status: 1,
    });
  });

  it("suggestKeywords sends the item list and returns suggestions, group bids and match types", async () => {
    const { client, calls } = makeClient(
      "us",
      route(
        "/keyword/getsuggest",
        ok(
          [
            {
              keyword: "3060",
              normalizedKeyword: "3060",
              items: ["9SIXXXXXXXXXXX1"],
              keywordUrl: "https://www.newegg.com/p/pl?d=3060",
              suggBid: 0.47,
              suggBidLowest: 0.47,
              suggBidMost: 1,
              bid: null,
              matchType: 0,
              searchVolume: "10000+",
              competition: "High",
            },
          ],
          {
            suggBid: 0.47,
            suggBidLowest: 0.46,
            suggBidMost: 1,
            matchTypes: [
              {
                matchType: 2,
                matchTypeName: "Close match",
                suggBid: 1.75,
                suggBidLowest: 0.4,
                suggBidMost: 3.1,
              },
            ],
          },
          "200",
        ),
      ),
    );
    const result = await client.ads.suggestKeywords({
      itemNumbers: ["9SIXXXXXXXXXXX1"],
      targeting: "manual",
      costModel: "cpc",
    });
    expect(calls[0]?.bodyJson).toEqual({
      sellerId: "A006",
      itemList: ["9SIXXXXXXXXXXX1"],
      keywordList: [],
      sponsorType: 0,
      type: 0,
      costModel: 1,
    });
    expect(result.rows[0]).toMatchObject({
      keyword: "3060",
      itemNumbers: ["9SIXXXXXXXXXXX1"],
      suggBidMost: 1,
      competition: "High",
    });
    expect(result.suggestedBid).toEqual({ suggBid: 0.47, suggBidLowest: 0.46, suggBidMost: 1 });
    expect(result.matchTypes).toEqual([
      {
        matchType: 2,
        matchTypeName: "Close match",
        suggBid: 1.75,
        suggBidLowest: 0.4,
        suggBidMost: 3.1,
        bid: undefined,
        activeStatus: undefined,
        status: undefined,
        declineReason: undefined,
      },
    ]);
    await expect(client.ads.suggestKeywords({ itemNumbers: [] })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    await expect(client.ads.suggestKeywords({ itemNumbers: ["bad item!"] })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
  });
});

describe("ads match types and targeting", () => {
  it("listMatchTypes uses the capital-D sellerID field of that page", async () => {
    const { client, calls } = makeClient(
      "us",
      route(
        "/autotargeting/matchtypesearch",
        ok(
          [
            {
              matchType: 2,
              matchTypeName: "Close match",
              suggBid: 0.55,
              bid: 0.76,
              status: "Delivering",
            },
            { matchTypeName: "no type" },
          ],
          {},
          "200",
        ),
      ),
    );
    const result = await client.ads.listMatchTypes({
      campaignNumber: 1000001,
      groupNumber: 1000002,
    });
    expect(calls[0]?.bodyJson).toEqual({
      sellerID: "A006",
      campaignNumber: 1000001,
      groupNumber: 1000002,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ matchType: 2, bid: 0.76, suggBid: 0.55 });
  });

  it("suggestCategoryTargeting and suggestItemTargeting send the type codes", async () => {
    const categories = makeClient(
      "us",
      route(
        "/producttargeting/categoriessearch",
        ok(
          [
            {
              relatedSubCode: "3515",
              priceSuggestBid: 0.5,
              priceLowerBound: 0.5,
              priceHigherBound: 0.85,
              lastEditDate: "2022-06-16 01:26:47",
            },
          ],
          {},
          "061",
        ),
      ),
    );
    const cat = await categories.client.ads.suggestCategoryTargeting({
      categoryCodes: ["3515", "10"],
      productType: "displayOnSite",
      mode: "search",
    });
    expect(categories.calls[0]?.bodyJson).toEqual({
      type: 1,
      productType: 2,
      categoryList: ["3515", "10"],
      countryCode: null,
    });
    expect(cat.rows[0]).toEqual({
      categoryCode: "3515",
      priceSuggestBid: 0.5,
      priceLowerBound: 0.5,
      priceHigherBound: 0.85,
      lastEditedAt: "2022-06-16 01:26:47",
    });

    const items = makeClient(
      "us",
      route(
        "/producttargeting/individualsearch",
        ok(
          [
            {
              itemNumber: "03O-0000-00001",
              relatedPrimaryItem: "03O-0000-00001",
              priceSuggestBid: 0.5,
              priceLowerBound: 0.5,
              priceHigherBound: 0.62,
            },
          ],
          {},
          "062",
        ),
      ),
    );
    const item = await items.client.ads.suggestItemTargeting({
      itemNumbers: ["03O-0000-00001"],
      productType: "productTargeting",
      countryCode: "USA",
    });
    expect(items.calls[0]?.bodyJson).toEqual({
      type: 0,
      productType: 1,
      itemNumberList: ["03O-0000-00001"],
      countryCode: "USA",
    });
    expect(item.rows[0]).toMatchObject({ itemNumber: "03O-0000-00001", priceHigherBound: 0.62 });
    await expect(
      items.client.ads.suggestItemTargeting({ itemNumbers: ["x"], productType: "nope" as never }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
  });
});

describe("ads performance reports", () => {
  it("getGroupPerformance sends the fixed extUrl, string ids and required dates", async () => {
    const { client, calls } = makeClient(
      "us",
      route(
        "/group/performance",
        ok([{ campaignNumber: 1000001, groupNumber: 1000002, groupName: "G", ...METRICS }]),
      ),
    );
    const result = await client.ads.getGroupPerformance({
      campaignNumber: 1000001,
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
    });
    expect(calls[0]?.bodyJson).toEqual({
      sellerId: "A006",
      countryCode: null,
      extUrl: "group/searchGroupByCampaign",
      campaignNumber: "1000001",
      type: null,
      sponsorType: null,
      searchKeywordType: null,
      keyword: null,
      activeStatus: null,
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
      pageInfo: { pageIndex: 1, pageSize: 100, sortField: null, sortType: null },
    });
    expect(result.rows[0]).toMatchObject({ groupNumber: 1000002, ...METRICS });
    await expect(
      client.ads.getGroupPerformance({ fromDate: "2026-01-01" } as never),
    ).rejects.toBeInstanceOf(NeweggValidationError);
  });

  it("reads the table's ACoS spelling as well as the sample's acos", async () => {
    const { client } = makeClient(
      "us",
      route("/group/performance", ok([{ groupNumber: 1, ACoS: 0.3, spend: "2" }])),
    );
    const result = await client.ads.getGroupPerformance({
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
    });
    expect(result.rows[0]).toMatchObject({ acos: 0.3, spend: 2 });
  });

  it("getProductPerformance and getKeywordPerformance send their extUrl and ids", async () => {
    const products = makeClient(
      "us",
      route(
        "/product/performance",
        ok([{ itemNumber: "9SIXXXXXXXXXXX1", inDate: "2022-07-19 02:47:08.920-0700", ...METRICS }]),
      ),
    );
    const product = await products.client.ads.getProductPerformance({
      campaignNumber: 1000001,
      groupNumber: 1000002,
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
      pageSize: 9_999_999,
    });
    expect(products.calls[0]?.bodyJson).toMatchObject({
      extUrl: "product/searchItems",
      countryCode: "USA",
      campaignNumber: "1000001",
      groupNumber: "1000002",
      pageInfo: { pageSize: 9_999_999 },
    });
    expect(product.rows[0]).toMatchObject({
      itemNumber: "9SIXXXXXXXXXXX1",
      createdAt: "2022-07-19 02:47:08.920-0700",
      clicks: 50,
    });

    const keywords = makeClient(
      "us",
      route(
        "/keyword/performance",
        ok([{ keyword: "usb hub", matchType: 1, bid: 0.1, ...METRICS }], {}, "200"),
      ),
    );
    const keyword = await keywords.client.ads.getKeywordPerformance({
      campaignNumber: 1000001,
      groupNumber: 1000002,
      keyword: "usb",
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
    });
    expect(keywords.calls[0]?.bodyJson).toMatchObject({
      extUrl: "keyword/searchKeywordList",
      searchKeywordType: "KEYWORD",
      keyword: "usb",
    });
    expect(keyword.rows[0]).toMatchObject({ keyword: "usb hub", orders: 4, cpc: 0.25 });
  });
});

describe("ads write endpoints are unreachable (contracts section 25.1)", () => {
  const READ_PATHS = new Set([
    "search",
    "group/search",
    "product/search",
    "keyword/search",
    "keyword/getsuggest",
    "negativekeyword/search",
    "autotargeting/matchtypesearch",
    "producttargeting/categoriessearch",
    "producttargeting/individualsearch",
    "group/performance",
    "product/performance",
    "keyword/performance",
  ]);
  const WRITE_PATHS = [
    "create",
    "update",
    "changestatus",
    "group/add",
    "group/update",
    "group/changestatus",
    "product/add",
    "product/changestatus",
    "keyword/add",
    "keyword/update",
    "keyword/changestatus",
    "negativekeyword/add",
    "producttargeting/add",
    "autotargeting/matchtypeupdate",
    "autotargeting/matchtypechangestatus",
  ];

  it("sends every read only to its documented read path, even with hostile-looking input", async () => {
    const catchAll: MockRoute[] = [
      {
        method: "POST",
        pathPattern: new RegExp(`^${ADS}/`),
        reply: () => ({ status: 200, body: ok([]) }),
      },
    ];
    const { client, calls } = makeClient("us", catchAll);
    const range = { fromDate: "2026-01-01", toDate: "2026-01-31" };
    const ids = { campaignNumber: 1000001, groupNumber: 1000002 };
    const hostile = "../create";
    await client.ads.listCampaigns({ keyword: hostile });
    await client.ads.listGroups({ campaignNumber: 1000001, keyword: hostile });
    await client.ads.listProducts({ ...ids, keyword: hostile });
    await client.ads.listKeywords({ ...ids, keyword: hostile });
    await client.ads.listNegativeKeywords({ ...ids, keyword: hostile });
    await client.ads.listMatchTypes(ids);
    await client.ads.suggestKeywords({ itemNumbers: ["9SIXXXXXXXXXXX1"], keywords: [hostile] });
    await client.ads.suggestCategoryTargeting({
      categoryCodes: ["1"],
      productType: "productTargeting",
    });
    await client.ads.suggestItemTargeting({
      itemNumbers: ["9SIXXXXXXXXXXX1"],
      productType: "productTargeting",
    });
    await client.ads.getGroupPerformance({ ...range, keyword: hostile });
    await client.ads.getProductPerformance({ ...ids, ...range, keyword: hostile });
    await client.ads.getKeywordPerformance({ ...ids, ...range, keyword: hostile });

    expect(calls).toHaveLength(12);
    const seen = new Set<string>();
    for (const call of calls) {
      expect(call.method).toBe("POST");
      const suffix = call.url.pathname.slice(`${ADS}/`.length);
      expect(READ_PATHS.has(suffix)).toBe(true);
      expect(WRITE_PATHS).not.toContain(suffix);
      seen.add(suffix);
    }
    expect(seen).toEqual(READ_PATHS);
  });
});

describe("ads input validation", () => {
  type Client = ReturnType<typeof makeClient>["client"];
  const rangeCalls: ReadonlyArray<readonly [string, (c: Client, r: object) => Promise<unknown>]> = [
    ["listCampaigns", (c, r) => c.ads.listCampaigns(r)],
    ["listGroups", (c, r) => c.ads.listGroups({ campaignNumber: 1, ...r })],
    [
      "getGroupPerformance",
      (c, r) => c.ads.getGroupPerformance({ fromDate: "2026-09-01", toDate: "2026-09-30", ...r }),
    ],
    [
      "getProductPerformance",
      (c, r) =>
        c.ads.getProductPerformance({
          campaignNumber: 1,
          groupNumber: 2,
          fromDate: "2026-09-01",
          toDate: "2026-09-30",
          ...r,
        }),
    ],
    [
      "getKeywordPerformance",
      (c, r) =>
        c.ads.getKeywordPerformance({
          campaignNumber: 1,
          groupNumber: 2,
          fromDate: "2026-09-01",
          toDate: "2026-09-30",
          ...r,
        }),
    ],
  ];

  it.each(rangeCalls)("%s rejects dates that are not real calendar days", async (_name, call) => {
    const { client, calls } = makeClient("us", route("", ok([])));
    for (const bad of ["2026-13-45", "2026-02-30", "2026-00-10", "2026-04-31"]) {
      await expect(call(client, { fromDate: bad })).rejects.toBeInstanceOf(NeweggValidationError);
      await expect(call(client, { toDate: bad })).rejects.toBeInstanceOf(NeweggValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it.each(rangeCalls)("%s rejects fromDate after toDate", async (_name, call) => {
    const { client, calls } = makeClient("us", route("", ok([])));
    await expect(call(client, { fromDate: "2026-10-02", toDate: "2026-10-01" })).rejects.toThrow(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("accepts a leap day, an equal range and a Date input", async () => {
    const { client, calls } = makeClient("us", route("/search", ok([])));
    await client.ads.listCampaigns({ fromDate: "2028-02-29", toDate: "2028-02-29" });
    await client.ads.listCampaigns({
      fromDate: new Date("2026-09-01T12:00:00Z"),
      toDate: "2026-09-30",
    });
    expect(calls).toHaveLength(2);
    await expect(client.ads.listCampaigns({ fromDate: "2027-02-29" })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
  });

  it("sends a Date input as its Pacific calendar day and refuses one that cannot render as a day", async () => {
    const { client, calls } = makeClient("us", route("/search", ok([])));
    // 03:00Z on the 1st is still the evening of Aug 31 in Pacific time.
    await client.ads.listCampaigns({
      fromDate: new Date("2026-09-01T03:00:00Z"),
      toDate: new Date("2026-09-30T12:00:00Z"),
    });
    expect(calls[0]?.bodyJson).toMatchObject({ fromDate: "2026-08-31", toDate: "2026-09-30" });
    await expect(client.ads.listCampaigns({ fromDate: new Date(8.64e15) })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    await expect(
      client.ads.listCampaigns({ fromDate: new Date(Number.NaN) }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(1);
  });

  it("rejects non-canonical day strings", async () => {
    const { client, calls } = makeClient("us", route("/search", ok([])));
    for (const bad of [
      "1900-02-29",
      "2100-02-29",
      " 2026-09-01",
      "2026-09-01 ",
      "2026-09-01\n",
      "2026-9-1",
    ]) {
      await expect(client.ads.listCampaigns({ fromDate: bad })).rejects.toBeInstanceOf(
        NeweggValidationError,
      );
    }
    await client.ads.listCampaigns({ fromDate: "2000-02-29" });
    expect(calls).toHaveLength(1);
  });

  it("bounds page at 10000 and rejects page 0", async () => {
    const { client, calls } = makeClient("us", route("/search", ok([])));
    await client.ads.listCampaigns({ page: 10_000 });
    expect(calls).toHaveLength(1);
    await expect(client.ads.listCampaigns({ page: 10_001 })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    await expect(client.ads.listCampaigns({ page: 0 })).rejects.toBeInstanceOf(
      NeweggValidationError,
    );
    expect(calls).toHaveLength(1);
  });

  it("keeps an empty page for a 200 with rows and an error-looking header, exposing msg and bizCode", async () => {
    const { client } = makeClient(
      "us",
      route("/search", {
        header: [{ msg: "seller not enrolled", bizCode: "403" }],
        rows: [],
        totalRows: 0,
      }),
    );
    const page = await client.ads.listCampaigns();
    expect(page.rows).toEqual([]);
    expect(page.message).toBe("seller not enrolled");
    expect(page.bizCode).toBe("403");
  });
});
