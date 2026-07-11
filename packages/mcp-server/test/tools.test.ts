import { describe, expect, it } from "vitest";
import {
  callTool,
  inventoryListRoute,
  makeEnv,
  serviceStatusRoute,
  startHarness,
} from "./helpers.js";

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; additionalProperties?: unknown };
  outputSchema?: { type?: string };
  annotations?: { title?: string; readOnlyHint?: boolean };
}

async function listTools(env?: Record<string, string | undefined>): Promise<ListedTool[]> {
  const harness = await startHarness({ env });
  try {
    const result = (await harness.mcp.listTools()) as { tools: ListedTool[] };
    return result.tools;
  } finally {
    await harness.close();
  }
}

describe("tools/list", () => {
  it("exposes exactly the 5 read tools when writes are disabled", async () => {
    const tools = await listTools(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }));
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "newegg_feed_result",
        "newegg_feed_status",
        "newegg_inventory_get",
        "newegg_inventory_preview_update",
        "newegg_service_status",
      ].sort(),
    );
    expect(names).not.toContain("newegg_inventory_apply_update");
  });

  it("adds the apply tool when writes are enabled (6 tools)", async () => {
    const tools = await listTools(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" }));
    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(6);
    expect(names).toContain("newegg_inventory_apply_update");
  });

  it("gives every tool a title, description, inputSchema, and outputSchema", async () => {
    const tools = await listTools(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" }));
    for (const tool of tools) {
      const title = tool.title ?? tool.annotations?.title;
      expect(title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
  });
});

describe("strict input schemas", () => {
  it("rejects an unknown key in newegg_inventory_get args", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute()] });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_get", {
        identifiers: [{ type: "sellerPartNumber", value: "A" }],
        surprise: true,
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rejects credential-like keys smuggled into any tool args", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute()] });
    try {
      for (const badKey of ["apiKey", "secretKey", "baseUrl", "overwrite"]) {
        const res = await callTool(harness.mcp, "newegg_inventory_get", {
          identifiers: [{ type: "sellerPartNumber", value: "A" }],
          [badKey]: "x",
        });
        expect(res.isError, `${badKey} should be rejected`).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });

  it("rejects an invalid identifier type", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute()] });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_get", {
        identifiers: [{ type: "notARealType", value: "A" }],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rejects a preview with more updates than the configured max", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_MCP_MAX_ITEMS_PER_OPERATION: "2", NEWEGG_MCP_ALLOW_WRITES: "true" }),
    });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_preview_update", {
        updates: [
          { identifier: { type: "sellerPartNumber", value: "A" }, quantity: 1 },
          { identifier: { type: "sellerPartNumber", value: "B" }, quantity: 2 },
          { identifier: { type: "sellerPartNumber", value: "C" }, quantity: 3 },
        ],
      });
      expect(res.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_inventory_get", () => {
  it("reads inventory and never leaks SDK raw", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute({ A: 9, B: 4 })] });
    try {
      const res = await callTool(harness.mcp, "newegg_inventory_get", {
        identifiers: [
          { type: "sellerPartNumber", value: "A" },
          { type: "sellerPartNumber", value: "B" },
        ],
      });
      expect(res.isError).toBe(false);
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent).toEqual(res.json);
      expect(res.json.marketplace).toBe("ca");
      const items = res.json.items as Array<{
        sellerPartNumber?: string;
        totalAvailableQuantity: number;
      }>;
      expect(items).toHaveLength(2);
      expect(items.map((item) => item.totalAvailableQuantity).sort()).toEqual([4, 9]);
      expect(res.text).not.toContain("raw");
    } finally {
      await harness.close();
    }
  });
});

describe("newegg_service_status", () => {
  it("reports availability from a wrapped response", async () => {
    const harness = await startHarness({ routes: [serviceStatusRoute("1")] });
    try {
      const res = await callTool(harness.mcp, "newegg_service_status", {});
      expect(res.isError).toBe(false);
      expect(res.json.available).toBe(true);
      expect(res.json.domain).toBe("contentmgmt");
    } finally {
      await harness.close();
    }
  });

  it("reports unavailability with a message", async () => {
    const harness = await startHarness({
      routes: [serviceStatusRoute("0", "Down for maintenance")],
    });
    try {
      const res = await callTool(harness.mcp, "newegg_service_status", { domain: "datafeedmgmt" });
      expect(res.json.available).toBe(false);
      expect(res.json.domain).toBe("datafeedmgmt");
      expect(res.json.message).toBe("Down for maintenance");
    } finally {
      await harness.close();
    }
  });
});
