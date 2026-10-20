import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, startHarness } from "./helpers.js";

/**
 * Synthetic fixtures modeled on the official §25 samples; identifiers and names are fictional
 * placeholders, nothing here is real account data.
 */
const route = (path: string, body: unknown, status = 200): MockRoute => ({
  method: "POST",
  pathPattern: new RegExp(`^/marketplace/sponsoredmgmt/campaign${path}\\?`),
  reply: () => ({ status, body }),
});

const ok = (rows: unknown[]) => ({
  header: [{ msg: "success", bizCode: "025" }],
  rows,
  totalRows: rows.length,
});

const US = makeEnv({ NEWEGG_MARKETPLACE: "us" });

const CAMPAIGN_ROW = {
  campaignNumber: "1000001",
  campaignName: "Example campaign",
  countryCode: "USA",
  type: 0,
  activeStatus: "Active",
  status: "Delivering",
  budget: "3000.0",
  dailyBudget: 100,
  groupCount: 1,
  costModel: 1,
};

describe("newegg_ads_campaigns_list", () => {
  it("forwards filters as a POST body and maps campaigns", async () => {
    const harness = await startHarness({ env: US, routes: [route("/search", ok([CAMPAIGN_ROW]))] });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_campaigns_list", {
        keyword: "Example",
        activeStatus: "active",
        pageSize: 10,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        marketplace: "us",
        totalRows: 1,
        pageSize: 10,
        message: "success",
        campaigns: [
          {
            campaignNumber: 1000001,
            name: "Example campaign",
            activeStatus: "Active",
            status: "Delivering",
            budget: 3000,
            dailyBudget: 100,
            groupCount: 1,
          },
        ],
      });
      const call = harness.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url.pathname).toBe("/marketplace/sponsoredmgmt/campaign/search");
      expect(call.bodyJson).toMatchObject({
        keyword: "Example",
        activeStatus: "Active",
        pageInfo: { pageSize: 10 },
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown keys and out-of-range paging without calling Newegg", async () => {
    const harness = await startHarness({ env: US, routes: [] });
    try {
      expect((await callTool(harness.mcp, "newegg_ads_campaigns_list", { bogus: 1 })).isError).toBe(
        true,
      );
      expect(
        (await callTool(harness.mcp, "newegg_ads_campaigns_list", { pageSize: 500 })).isError,
      ).toBe(true);
      expect(
        (await callTool(harness.mcp, "newegg_ads_campaigns_list", { fromDate: "06/01/2026" }))
          .isError,
      ).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("returns an unsupported_operation error on Newegg Business and Canada without sending", async () => {
    for (const marketplace of ["b2b", "ca"]) {
      const harness = await startHarness({
        env: makeEnv({ NEWEGG_MARKETPLACE: marketplace }),
        routes: [],
      });
      try {
        const res = await callTool(harness.mcp, "newegg_ads_campaigns_list", {});
        expect(res.isError).toBe(true);
        expect(res.json).toMatchObject({ errorCode: "unsupported_operation" });
        expect(harness.calls).toHaveLength(0);
      } finally {
        await harness.close();
      }
    }
  });

  it("maps upstream errors to a structured tool error", async () => {
    const harness = await startHarness({
      env: US,
      routes: [route("/search", [{ Code: "CE001", Message: "bad request" }], 400)],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_campaigns_list", {});
      expect(res.isError).toBe(true);
      expect(res.json).toMatchObject({ neweggErrorCode: "CE001", httpStatus: 400 });
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_ads_campaign_get", () => {
  it("searches by campaign number and reports found", async () => {
    const harness = await startHarness({ env: US, routes: [route("/search", ok([CAMPAIGN_ROW]))] });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_campaign_get", {
        campaignNumber: 1000001,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ found: true, campaign: { campaignNumber: 1000001 } });
      expect(harness.calls[0]!.bodyJson).toMatchObject({
        searchKeywordType: "CAMPAIGN_NUM",
        keyword: "1000001",
      });
    } finally {
      await harness.close();
    }
  });

  it("reports found=false when the account has no such campaign", async () => {
    const harness = await startHarness({ env: US, routes: [route("/search", ok([]))] });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_campaign_get", {
        campaignNumber: 1000009,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ found: false });
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_ads_groups_list", () => {
  it("lists the ad groups of a campaign", async () => {
    const harness = await startHarness({
      env: US,
      routes: [
        route(
          "/group/search",
          ok([
            {
              campaignNumber: "1000001",
              groupNumber: "1000002",
              groupName: "Example group",
              defaultBid: "0.5",
              keywordSize: 3,
              productSize: 1,
              productList: ["9SIXXXXXXXXXXX1"],
              activeStatus: "Active",
              status: "Delivering",
            },
          ]),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_groups_list", {
        campaignNumber: 1000001,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        totalRows: 1,
        groups: [
          {
            groupNumber: 1000002,
            groupName: "Example group",
            defaultBid: 0.5,
            keywordCount: 3,
            productItemNumbers: ["9SIXXXXXXXXXXX1"],
          },
        ],
      });
      expect(harness.calls[0]!.bodyJson).toMatchObject({ campaignNumber: 1000001 });
    } finally {
      await harness.close();
    }
  });

  it("requires a campaign number", async () => {
    const harness = await startHarness({ env: US, routes: [] });
    try {
      expect((await callTool(harness.mcp, "newegg_ads_groups_list", {})).isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_ads_keywords_list", () => {
  it("lists keywords with match type and bid", async () => {
    const harness = await startHarness({
      env: US,
      routes: [
        route(
          "/keyword/search",
          ok([
            {
              campaignNumber: "1000001",
              groupNumber: "1000002",
              keyword: "example keyword",
              matchType: 1,
              bid: "0.4",
              competition: "Low",
              activeStatus: "Active",
            },
          ]),
        ),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_keywords_list", {
        campaignNumber: 1000001,
        groupNumber: 1000002,
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        keywords: [{ keyword: "example keyword", matchType: 1, bid: 0.4, competition: "Low" }],
      });
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_ads_report", () => {
  const METRICS = {
    spend: 12.5,
    sales: 100,
    acos: 0.125,
    impressions: 1000,
    clicks: 50,
    orders: 4,
  };

  it("runs the group report with string ids and the fixed extUrl", async () => {
    const harness = await startHarness({
      env: US,
      routes: [
        route("/group/performance", ok([{ groupNumber: "1000002", groupName: "G", ...METRICS }])),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_report", {
        level: "group",
        campaignNumber: 1000001,
        fromDate: "2026-09-01",
        toDate: "2026-09-30",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        level: "group",
        totalRows: 1,
        rows: [{ groupNumber: 1000002, spend: 12.5, acos: 0.125, clicks: 50 }],
      });
      expect(harness.calls[0]!.bodyJson).toMatchObject({
        extUrl: "group/searchGroupByCampaign",
        fromDate: "2026-09-01",
        toDate: "2026-09-30",
      });
    } finally {
      await harness.close();
    }
  });

  it("runs the keyword report for one ad group", async () => {
    const harness = await startHarness({
      env: US,
      routes: [route("/keyword/performance", ok([{ keyword: "example keyword", ...METRICS }]))],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_report", {
        level: "keyword",
        campaignNumber: 1000001,
        groupNumber: 1000002,
        fromDate: "2026-09-01",
        toDate: "2026-09-30",
      });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        level: "keyword",
        rows: [{ keyword: "example keyword", spend: 12.5 }],
      });
      expect(harness.calls[0]!.bodyJson).toMatchObject({ extUrl: "keyword/searchKeywordList" });
    } finally {
      await harness.close();
    }
  });

  it("requires campaign and group numbers for the product and keyword reports", async () => {
    const harness = await startHarness({ env: US, routes: [] });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_report", {
        level: "product",
        fromDate: "2026-09-01",
        toDate: "2026-09-30",
      });
      expect(res.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects missing dates and unknown levels", async () => {
    const harness = await startHarness({ env: US, routes: [] });
    try {
      expect((await callTool(harness.mcp, "newegg_ads_report", { level: "group" })).isError).toBe(
        true,
      );
      expect(
        (
          await callTool(harness.mcp, "newegg_ads_report", {
            level: "campaign",
            fromDate: "2026-09-01",
            toDate: "2026-09-30",
          })
        ).isError,
      ).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe("ads input validation", () => {
  const REPORT = { level: "group", fromDate: "2026-09-01", toDate: "2026-09-30" };

  it("refuses impossible calendar dates and reversed ranges without calling Newegg", async () => {
    const harness = await startHarness({ env: US, routes: [] });
    try {
      for (const bad of ["2026-13-45", "2026-02-30"]) {
        expect(
          (await callTool(harness.mcp, "newegg_ads_campaigns_list", { fromDate: bad })).isError,
        ).toBe(true);
        expect(
          (await callTool(harness.mcp, "newegg_ads_report", { ...REPORT, fromDate: bad })).isError,
        ).toBe(true);
      }
      const reversed = { fromDate: "2026-10-02", toDate: "2026-10-01" };
      expect((await callTool(harness.mcp, "newegg_ads_campaigns_list", reversed)).isError).toBe(
        true,
      );
      expect(
        (await callTool(harness.mcp, "newegg_ads_report", { level: "group", ...reversed })).isError,
      ).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("accepts an equal range and a leap day", async () => {
    const harness = await startHarness({
      env: US,
      routes: [route("/search", ok([])), route("/group/performance", ok([]))],
    });
    try {
      expect(
        (
          await callTool(harness.mcp, "newegg_ads_campaigns_list", {
            fromDate: "2028-02-29",
            toDate: "2028-02-29",
          })
        ).isError,
      ).toBe(false);
      expect(
        (
          await callTool(harness.mcp, "newegg_ads_report", {
            ...REPORT,
            fromDate: "2026-09-30",
          })
        ).isError,
      ).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("bounds page at 10000 on list and report tools", async () => {
    const harness = await startHarness({ env: US, routes: [route("/search", ok([]))] });
    try {
      expect(
        (await callTool(harness.mcp, "newegg_ads_campaigns_list", { page: 10_001 })).isError,
      ).toBe(true);
      expect(
        (await callTool(harness.mcp, "newegg_ads_report", { ...REPORT, page: 10_001 })).isError,
      ).toBe(true);
      expect(harness.calls).toHaveLength(0);
      expect(
        (await callTool(harness.mcp, "newegg_ads_campaigns_list", { page: 10_000 })).isError,
      ).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("exposes bizCode next to message when a 200 carries rows and an error-looking header", async () => {
    const harness = await startHarness({
      env: US,
      routes: [
        route("/search", {
          header: [{ msg: "seller not enrolled", bizCode: "403" }],
          rows: [],
          totalRows: 0,
        }),
      ],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_ads_campaigns_list", {});
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({
        campaigns: [],
        message: "seller not enrolled",
        bizCode: "403",
      });
    } finally {
      await harness.close();
    }
  });
});
