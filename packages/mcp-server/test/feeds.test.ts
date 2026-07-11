import { describe, expect, it } from "vitest";
import {
  callTool,
  feedResultBody,
  feedResultRoute,
  feedStatusRoute,
  feedSubmitRoute,
  makeEnv,
  startHarness,
} from "./helpers.js";

describe("apply via the feed path", () => {
  it("submits a feed and returns feed jobs + submitted items + a poll instruction", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" }),
      routes: [feedSubmitRoute("REQ777")],
    });
    try {
      const preview = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        strategy: "feed",
        updates: [
          { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 5 },
          { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 6 },
        ],
      });
      const previewId = preview.json.previewId as string;

      const apply = await callTool(harness.mcp, "newegg_inventory_apply_update", { previewId });
      expect(apply.isError).toBe(false);
      expect(apply.json.strategy).toBe("feed");
      const feedJobs = apply.json.feedJobs as Array<{ requestId: string; itemCount: number }>;
      expect(feedJobs).toBeDefined();
      expect(feedJobs[0]?.requestId).toBe("REQ777");
      const items = apply.json.items as Array<{ status: string }>;
      expect(items.length).toBe(2);
      expect(items.every((item) => item.status === "submitted")).toBe(true);
      const warnings = apply.json.warnings as string[];
      expect(warnings.some((w) => w.includes("newegg_feed_status"))).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_feed_status", () => {
  it("returns FINISHED for a matching request id", async () => {
    const harness = await startHarness({ routes: [feedStatusRoute("REQ1", "FINISHED")] });
    try {
      const res = await callTool(harness.mcp, "newegg_feed_status", { requestId: "REQ1" });
      expect(res.isError).toBe(false);
      expect(res.json.status).toBe("FINISHED");
      expect(res.json.requestId).toBe("REQ1");
    } finally {
      await harness.close();
    }
  });

  it("rejects a non-alphanumeric request id via the input schema", async () => {
    const harness = await startHarness({ routes: [feedStatusRoute("REQ1", "FINISHED")] });
    try {
      const res = await callTool(harness.mcp, "newegg_feed_status", { requestId: "bad-id!" });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_feed_result", () => {
  it("parses a FINISHED result with a summary and detailed records", async () => {
    const body = feedResultBody([
      { sku: "sellerparttest001", error: "Error(s). Item not created." },
    ]);
    const harness = await startHarness({ routes: [feedResultRoute(body)] });
    try {
      const res = await callTool(harness.mcp, "newegg_feed_result", { requestId: "REQ1" });
      expect(res.isError).toBe(false);
      expect(res.json.status).toBe("FINISHED");
      expect(res.json.summary).toEqual({ processed: 3, succeeded: 1, failed: 2 });
      const records = res.json.records as Array<{ sellerPartNumber?: string; status: string }>;
      expect(records[0]?.sellerPartNumber).toBe("sellerparttest001");
      expect(records[0]?.status).toBe("failed");
      expect(res.json.recordsTruncated).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("caps records at 500 and flags truncation", async () => {
    const many = Array.from({ length: 501 }, (_, index) => ({
      sku: `SKU${index}`,
      error: "Item not created.",
    }));
    const body = feedResultBody(many, { processed: 501, succeeded: 0, failed: 501 });
    const harness = await startHarness({ routes: [feedResultRoute(body)] });
    try {
      const res = await callTool(harness.mcp, "newegg_feed_result", { requestId: "REQ1" });
      expect(res.isError).toBe(false);
      expect((res.json.records as unknown[]).length).toBe(500);
      expect(res.json.recordsTruncated).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("maps an invalid-request-id (DF006) body to a structured tool error", async () => {
    const harness = await startHarness({
      routes: [feedResultRoute([{ Code: "DF006", Message: "invalid request id" }])],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_feed_result", { requestId: "BADID" });
      expect(res.isError).toBe(true);
      expect(res.json.errorCode).toBe("api");
    } finally {
      await harness.close();
    }
  });
});
