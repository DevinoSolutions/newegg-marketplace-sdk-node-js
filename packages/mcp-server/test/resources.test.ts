import { describe, expect, it } from "vitest";
import { type Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  callTool,
  feedStatusRoute,
  inventoryListRoute,
  makeEnv,
  SENTINELS,
  startHarness,
} from "./helpers.js";

interface ResourceRead {
  contents: Array<{ uri: string; mimeType?: string; text?: string }>;
}

async function readResource(
  mcp: Client,
  uri: string,
): Promise<{ text: string; json: Record<string, unknown> }> {
  const res = (await mcp.readResource({ uri })) as ResourceRead;
  const text = res.contents[0]?.text ?? "";
  return { text, json: JSON.parse(text) as Record<string, unknown> };
}

describe("resources", () => {
  it("lists the two static resources", async () => {
    const harness = await startHarness();
    try {
      const res = (await harness.mcp.listResources()) as { resources: Array<{ uri: string }> };
      const uris = res.resources.map((resource) => resource.uri);
      expect(uris).toContain("newegg://capabilities");
      expect(uris).toContain("newegg://configuration/public");
    } finally {
      await harness.close();
    }
  });

  it("serves capabilities with the enabled tool set and limits", async () => {
    const harness = await startHarness({ env: makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "false" }) });
    try {
      const { json } = await readResource(harness.mcp, "newegg://capabilities");
      expect(json.serverName).toBe("newegg-marketplace-mcp");
      expect(typeof json.sdkVersion).toBe("string");
      expect(json.writesEnabled).toBe(false);
      expect(json.marketplace).toBe("ca");
      const tools = json.mcpTools as string[];
      expect(tools).toHaveLength(8);
      expect(tools).toContain("newegg_inventory_get");
      expect(tools).toContain("newegg_orders_list");
      expect(tools).not.toContain("newegg_inventory_apply_update");
    } finally {
      await harness.close();
    }
  });

  it("serves public configuration with batch limits and no secrets", async () => {
    const harness = await startHarness({
      env: makeEnv({ NEWEGG_API_BASE_URL: "https://proxy.example/secret-path/" }),
    });
    try {
      const { text, json } = await readResource(harness.mcp, "newegg://configuration/public");
      expect(json.marketplace).toBe("ca");
      const batchLimits = json.batchLimits as Record<string, number>;
      expect(batchLimits.feedMaxRecords).toBeGreaterThan(0);
      expect(batchLimits.batchReadChunkSize).toBeGreaterThan(0);
      // Never exposes credentials or the base-URL override.
      expect(text).not.toContain(SENTINELS.sellerId);
      expect(text).not.toContain(SENTINELS.apiKey);
      expect(text).not.toContain(SENTINELS.secretKey);
      expect(text).not.toContain("proxy.example");
    } finally {
      await harness.close();
    }
  });

  it("resolves the feeds template resource to a status payload", async () => {
    const harness = await startHarness({ routes: [feedStatusRoute("REQ1", "IN_PROGRESS")] });
    try {
      const { json } = await readResource(harness.mcp, "newegg://feeds/REQ1");
      expect(json.requestId).toBe("REQ1");
      expect(json.status).toBe("IN_PROGRESS");
    } finally {
      await harness.close();
    }
  });
});

describe("no credential leakage", () => {
  it("keeps sentinel credentials out of every serialized resource and tool result", async () => {
    const harness = await startHarness({ routes: [inventoryListRoute({ A: 3 })] });
    try {
      const capabilities = await harness.mcp.readResource({ uri: "newegg://capabilities" });
      const configuration = await harness.mcp.readResource({
        uri: "newegg://configuration/public",
      });
      const toolResult = await harness.mcp.callTool({
        name: "newegg_inventory_get",
        arguments: { identifiers: [{ type: "sellerPartNumber", value: "A" }] },
      });
      const blob = JSON.stringify([capabilities, configuration, toolResult]);
      for (const secret of [
        SENTINELS.sellerId,
        SENTINELS.apiKey,
        SENTINELS.secretKey,
        SENTINELS.bearer,
      ]) {
        expect(blob).not.toContain(secret);
      }
    } finally {
      await harness.close();
    }
  });
});

describe("stdout discipline", () => {
  it("writes nothing to stdout during an InMemory session with logging active", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writes: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      // No logger injected -> the default JSON-lines-on-stderr logger is active.
      const harness = await startHarness({ routes: [inventoryListRoute({ A: 1 })] });
      await harness.mcp.listTools();
      await callTool(harness.mcp, "newegg_inventory_get", {
        identifiers: [{ type: "sellerPartNumber", value: "A" }],
      });
      await harness.mcp.readResource({ uri: "newegg://capabilities" });
      await harness.close();
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes).toEqual([]);
  });
});
