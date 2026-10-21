import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, startHarness } from "./helpers.js";

/** Currency-less empty page: passes the credential-binding currency guard on every marketplace. */
const EMPTY_PAGE = {
  IsSuccess: true,
  OperationType: "GetOrderInfoResponse",
  ResponseBody: { PageInfo: { TotalCount: 0, TotalPageCount: 0, PageIndex: 1, PageSize: 100 } },
};

const route: MockRoute = {
  method: "PUT",
  pathPattern: /ordermgmt\/order\/orderinfo/,
  reply: () => ({ status: 200, body: EMPTY_PAGE }),
};

const US_ONLY_ARGS: Array<[string, Record<string, unknown>]> = [
  ["countryCode", { countryCode: "USA" }],
  ["premierOrder", { premierOrder: "premierOnly" }],
  ["type nws", { type: "nws" }],
];

describe("newegg_orders_list per-marketplace criteria (T-5912)", () => {
  for (const marketplace of ["ca", "b2b"]) {
    for (const [label, args] of US_ONLY_ARGS) {
      it(`${label} on ${marketplace} is a typed unsupported_operation error and sends nothing`, async () => {
        const harness = await startHarness({
          env: makeEnv({ NEWEGG_MARKETPLACE: marketplace }),
          routes: [route],
        });
        try {
          const res = await callTool(harness.mcp, "newegg_orders_list", args);
          expect(res.isError).toBe(true);
          expect(res.json).toMatchObject({ errorCode: "unsupported_operation", retryable: false });
          expect(String(res.json.message)).toContain(marketplace);
          expect(harness.calls).toHaveLength(0);
        } finally {
          await harness.close();
        }
      });
    }
  }

  it("countryCode is forwarded on us", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MARKETPLACE: "us" }),
      routes: [route],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_orders_list", { countryCode: "USA" });
      expect(res.isError).toBe(false);
      const criteria = (
        harness.calls[0]!.bodyJson as { RequestBody: { RequestCriteria: Record<string, unknown> } }
      ).RequestBody.RequestCriteria;
      expect(criteria.CountryCode).toBe("USA");
    } finally {
      await harness.close();
    }
  });

  for (const marketplace of ["us", "b2b", "ca"]) {
    it(`lastUpdatedAfter (Pacific-converted) and isInternal are forwarded on ${marketplace}`, async () => {
      const harness = await startHarness({
        env: makeEnv({ NEWEGG_MARKETPLACE: marketplace }),
        routes: [route],
      });
      try {
        // 20:30:00Z on 2026-06-15 is 13:30:00 Pacific (PDT).
        const res = await callTool(harness.mcp, "newegg_orders_list", {
          lastUpdatedAfter: "2026-06-15T20:30:00.000Z",
          isInternal: false,
        });
        expect(res.isError).toBe(false);
        const criteria = (
          harness.calls[0]!.bodyJson as {
            RequestBody: { RequestCriteria: Record<string, unknown> };
          }
        ).RequestBody.RequestCriteria;
        expect(criteria).toEqual({ LastUpdatedAfter: "2026-06-15 13:30:00", IsInternal: 0 });
      } finally {
        await harness.close();
      }
    });
  }

  it("rejects a non-boolean isInternal at the schema boundary", async () => {
    const harness = await startHarness({ routes: [route] });
    try {
      const res = await callTool(harness.mcp, "newegg_orders_list", { isInternal: "true" });
      expect(res.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("documents the us-only filters in the tool schema", async () => {
    const harness = await startHarness({ routes: [route] });
    try {
      const { tools } = await harness.mcp.listTools();
      const tool = tools.find((t) => t.name === "newegg_orders_list");
      const props = (tool?.inputSchema as { properties: Record<string, { description?: string }> })
        .properties;
      for (const key of ["countryCode", "premierOrder", "type"]) {
        expect(props[key]?.description).toContain("us");
      }
      expect(props.countryCode?.description).toContain("Newegg.com (us) only");
      expect(props.lastUpdatedAfter?.description).toBeTruthy();
      expect(props.isInternal?.description).toContain("unverified");
    } finally {
      await harness.close();
    }
  });
});
