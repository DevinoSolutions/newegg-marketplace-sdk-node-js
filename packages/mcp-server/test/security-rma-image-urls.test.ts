import { describe, expect, it } from "vitest";
import { callTool, makeEnv, startHarness } from "./helpers.js";
import { ORDER_NUMBER, SKU, readRoutes } from "./service-write-fixtures.js";

// T-5673 (I1): the MCP RMA tools reject non-https and credential-bearing evidence image URLs at the
// tool boundary, before any preview is planned.

const item = (imageUrls: string[]) => ({
  sellerPartNumber: SKU,
  returnQuantity: 1,
  reason: "defective",
  returnUnitPrice: 40,
  refundShippingPrice: 0,
  imageUrls,
});

const submit = (imageUrls: string[]) => ({
  orderNumber: ORDER_NUMBER,
  type: "refund",
  items: [item(imageUrls)],
});

describe("MCP RMA imageUrls are https without userinfo (T-5673 / I1)", () => {
  it("rejects http and userinfo URLs without echoing the credentials", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" }),
      routes: readRoutes(),
    });
    try {
      for (const bad of ["http://img.example/a.jpg", "https://user:s3cretpw@img.example/a.jpg"]) {
        const res = await callTool(harness.mcp, "newegg_rma_preview_submit", submit([bad]));
        expect(res.isError).toBe(true);
        expect(res.text).toContain("https");
        expect(res.text).not.toContain("s3cretpw");
      }
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("still plans a preview for a plain https URL", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" }),
      routes: readRoutes(),
    });
    try {
      const res = await callTool(
        harness.mcp,
        "newegg_rma_preview_submit",
        submit(["https://img.example/a.jpg"]),
      );
      expect(res.isError).toBe(false);
      expect(res.json.mode).toBe("preview");
    } finally {
      await harness.close();
    }
  });
});
