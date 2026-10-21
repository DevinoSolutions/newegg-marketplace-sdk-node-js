import { describe, expect, it } from "vitest";
import { UnsupportedMarketplaceOperationError } from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live reads of the Sponsored Ads endpoints against the REAL Newegg API (contracts §25:
 * Campaign List, Group List and Group Performance Report; all send a request body but only
 * read). Every create / add / update / change-status operation is never called. Shapes are
 * asserted, never account-specific values. Sponsored Ads is supported on Newegg.com and Newegg.ca
 * (CA probed 2026-10-21: zero campaigns, so rows may be empty); on Business the SDK must fail
 * before any request is sent. At most three requests in total.
 */
describe.skipIf(!liveEnabled)("live (read-only): Sponsored Ads reads", () => {
  const client = makeLiveClient();
  const supported = marketplace() === "us" || marketplace() === "ca";

  it("is rejected before sending on Business", async (ctx) => {
    if (supported) {
      ctx.skip();
      return;
    }
    await expect(client.ads.listCampaigns()).rejects.toBeInstanceOf(
      UnsupportedMarketplaceOperationError,
    );
  });

  it("listCampaigns returns a parsed page and the group reads follow from it", async (ctx) => {
    if (!supported) {
      ctx.skip();
      return;
    }
    const page = await client.ads.listCampaigns({ pageSize: 5 });
    expect(page.marketplace).toBe(marketplace());
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(5);
    expect(Array.isArray(page.rows)).toBe(true);
    expect(page.totalRows).toBeGreaterThanOrEqual(page.rows.length);
    for (const campaign of page.rows) {
      expect(Number.isInteger(campaign.campaignNumber)).toBe(true);
    }

    const first = page.rows[0];
    if (first === undefined) {
      // no campaigns on this account (the CA account has none): nothing further to read
      expect(page.totalRows).toBe(0);
      return;
    }
    const groups = await client.ads.listGroups({
      campaignNumber: first.campaignNumber,
      pageSize: 5,
    });
    expect(Array.isArray(groups.rows)).toBe(true);
    for (const group of groups.rows) {
      expect(Number.isInteger(group.groupNumber)).toBe(true);
      expect(Array.isArray(group.productItemNumbers)).toBe(true);
    }

    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const report = await client.ads.getGroupPerformance({
      campaignNumber: first.campaignNumber,
      fromDate: day(fromDate),
      toDate: day(toDate),
      pageSize: 5,
    });
    expect(Array.isArray(report.rows)).toBe(true);
    for (const row of report.rows) {
      expect(Number.isInteger(row.groupNumber)).toBe(true);
    }
  });
});
