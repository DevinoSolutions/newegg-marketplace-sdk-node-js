import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";
import { loadMcpConfigFromEnv, McpConfigError } from "../src/index.js";
import { callTool, makeEnv, SENTINELS, serviceStatusRoute, startHarness } from "./helpers.js";

describe("parseCliArgs", () => {
  it("defaults to the stdio transport", () => {
    expect(parseCliArgs([])).toEqual({ transport: "stdio", help: false });
  });

  it("parses --transport http (space and = forms)", () => {
    expect(parseCliArgs(["--transport", "http"])).toEqual({ transport: "http", help: false });
    expect(parseCliArgs(["--transport=http"])).toEqual({ transport: "http", help: false });
  });

  it("parses help flags", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
  });

  it("throws on an invalid transport or unknown argument", () => {
    expect(() => parseCliArgs(["--transport", "carrier-pigeon"])).toThrow(/transport/);
    expect(() => parseCliArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("loadMcpConfigFromEnv", () => {
  it("applies documented defaults", () => {
    const config = loadMcpConfigFromEnv(makeEnv());
    expect(config.marketplace).toBe("ca");
    expect(config.allowWrites).toBe(false);
    expect(config.limits.maxItemsPerOperation).toBe(500);
    expect(config.limits.previewTtlSeconds).toBe(600);
    expect(config.limits.allowZeroQuantity).toBe(true);
    expect(config.limits.allowedWarehouses).toEqual([]);
    expect(config.http.host).toBe("127.0.0.1");
    expect(config.http.port).toBe(3919);
    expect(config.http.bearerToken).toBeUndefined();
  });

  it("normalizes the 'can' alias and is case-insensitive", () => {
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MARKETPLACE: "CAN" })).marketplace).toBe("ca");
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MARKETPLACE: "US" })).marketplace).toBe("us");
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MARKETPLACE: "b2b" })).marketplace).toBe("b2b");
  });

  it("parses CSV warehouse allowlists and uppercases them", () => {
    const config = loadMcpConfigFromEnv(
      makeEnv({ NEWEGG_MCP_ALLOWED_WAREHOUSES: "usa, can ,mex" }),
    );
    expect(config.limits.allowedWarehouses).toEqual(["USA", "CAN", "MEX"]);
  });

  it("enables writes only for the exact string 'true'", () => {
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" })).allowWrites).toBe(
      true,
    );
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "TRUE" })).allowWrites).toBe(
      false,
    );
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "1" })).allowWrites).toBe(false);
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: undefined })).allowWrites).toBe(
      false,
    );
  });

  it("reports a missing credential by variable name without echoing other secrets", () => {
    const env = makeEnv({ NEWEGG_API_KEY: undefined });
    let message = "";
    try {
      loadMcpConfigFromEnv(env);
      throw new Error("expected loadMcpConfigFromEnv to throw");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("NEWEGG_API_KEY");
    expect(message).not.toContain(SENTINELS.secretKey);
    expect(message).not.toContain(SENTINELS.sellerId);
  });

  it("redacts credentials on serialization but exposes raw values by field", () => {
    const config = loadMcpConfigFromEnv(makeEnv());
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(SENTINELS.apiKey);
    expect(serialized).not.toContain(SENTINELS.secretKey);
    expect(serialized).not.toContain(SENTINELS.sellerId);
    expect(config.credentials.apiKey).toBe(SENTINELS.apiKey);
    expect(config.credentials.sellerId).toBe(SENTINELS.sellerId);
  });

  it("aggregates every missing/invalid variable into a single message", () => {
    let message = "";
    try {
      loadMcpConfigFromEnv(
        makeEnv({
          NEWEGG_SELLER_ID: undefined,
          NEWEGG_API_KEY: undefined,
          NEWEGG_SECRET_KEY: undefined,
          NEWEGG_MARKETPLACE: "moon",
          NEWEGG_MCP_HTTP_PORT: "70000",
        }),
      );
      throw new Error("expected loadMcpConfigFromEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfigError);
      message = error instanceof Error ? error.message : String(error);
    }
    // One pass reports ALL problems at once — an operator fixes everything in one restart.
    for (const name of [
      "NEWEGG_SELLER_ID",
      "NEWEGG_API_KEY",
      "NEWEGG_SECRET_KEY",
      "NEWEGG_MARKETPLACE",
      "NEWEGG_MCP_HTTP_PORT",
    ]) {
      expect(message).toContain(name);
    }
  });

  it("rejects an unknown marketplace value by name", () => {
    try {
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MARKETPLACE: "moon" }));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfigError);
      expect((error as Error).message).toContain("NEWEGG_MARKETPLACE");
    }
  });

  it("rejects a port outside 1..65535 without echoing the value", () => {
    try {
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_HTTP_PORT: "70000" }));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfigError);
      const message = (error as Error).message;
      expect(message).toContain("NEWEGG_MCP_HTTP_PORT");
      expect(message).not.toContain("70000"); // messages name the variable, never echo its value
    }
  });

  it("rejects a non-integer numeric limit", () => {
    expect(() =>
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_MAX_ITEMS_PER_OPERATION: "abc" })),
    ).toThrow(/NEWEGG_MCP_MAX_ITEMS_PER_OPERATION/);
  });
});

describe("env-driven boot smoke", () => {
  it("boots createNeweggMcpServer(loadMcpConfigFromEnv(env)) with an injected client", async () => {
    // startHarness runs exactly this path (default preview store created internally).
    const harness = await startHarness({ env: makeEnv(), routes: [serviceStatusRoute("1")] });
    try {
      const res = await callTool(harness.mcp, "newegg_service_status", {});
      expect(res.isError).toBe(false);
      expect(res.json.available).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
