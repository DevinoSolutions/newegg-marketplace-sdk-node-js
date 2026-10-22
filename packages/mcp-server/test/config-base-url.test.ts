import { describe, expect, it } from "vitest";
import { NeweggConfigurationError } from "@devino/newegg-marketplace-sdk";
import { createNeweggMcpServer, loadMcpConfigFromEnv, type Logger } from "../src/index.js";
import { makeEnv, SENTINELS } from "./helpers.js";

// T-6217: NEWEGG_API_BASE_URL is allowlisted to Newegg hosts; a custom host needs an explicit opt-in.

interface LogLine {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: (level, event, fields) => {
      lines.push({ level, event, fields });
    },
  };
}

function build(env: Record<string, string | undefined>, logger?: Logger) {
  return createNeweggMcpServer({ config: loadMcpConfigFromEnv(makeEnv(env)), logger });
}

describe("NEWEGG_API_BASE_URL allowlist (T-6217)", () => {
  it("accepts the default Newegg endpoint and Newegg subdomains", async () => {
    for (const url of [
      undefined,
      "https://api.newegg.com/marketplace/",
      "https://sandbox.api.newegg.com/marketplace/",
    ]) {
      const instance = build({ NEWEGG_API_BASE_URL: url });
      await instance.close();
    }
  });

  it("allows loopback http without the opt-in", async () => {
    const instance = build({ NEWEGG_API_BASE_URL: "http://127.0.0.1:9000/marketplace/" });
    await instance.close();
  });

  it.each([
    "https://attacker.example/marketplace/",
    "https://evilnewegg.com/marketplace/",
    "https://newegg.com@evil.example/marketplace/",
    "https://newegg.com.evil.example/marketplace/",
  ])("refuses %s by default without leaking credentials", (url) => {
    let thrown: unknown;
    try {
      build({ NEWEGG_API_BASE_URL: url });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NeweggConfigurationError);
    const message = (thrown as Error).message;
    expect(message).toContain("allowCustomBaseUrl");
    for (const secret of Object.values(SENTINELS)) expect(message).not.toContain(secret);
  });

  it("allows a custom host with NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL=true and warns once with the host only", async () => {
    const { logger, lines } = recordingLogger();
    const instance = build(
      {
        NEWEGG_API_BASE_URL: "https://proxy.example/secret-path/",
        NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL: "true",
      },
      logger,
    );
    try {
      const warnings = lines.filter((line) => line.level === "warn");
      expect(warnings).toHaveLength(1);
      const serialized = JSON.stringify(warnings[0]);
      expect(serialized).toContain("proxy.example");
      for (const leaked of ["secret-path"]) {
        expect(serialized).not.toContain(leaked);
      }
      for (const secret of Object.values(SENTINELS)) expect(serialized).not.toContain(secret);
    } finally {
      await instance.close();
    }
  });

  it("does not warn for a Newegg host or loopback", async () => {
    for (const url of ["https://api.newegg.com/marketplace/", "http://localhost:9000/m/"]) {
      const { logger, lines } = recordingLogger();
      const instance = build(
        { NEWEGG_API_BASE_URL: url, NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL: "true" },
        logger,
      );
      expect(lines.filter((line) => line.level === "warn")).toEqual([]);
      await instance.close();
    }
  });

  it("parses NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL strictly", () => {
    expect(loadMcpConfigFromEnv(makeEnv()).allowCustomBaseUrl).toBe(false);
    expect(
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL: "true" }))
        .allowCustomBaseUrl,
    ).toBe(true);
    expect(() =>
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL: "yes" })),
    ).toThrow(/NEWEGG_MCP_ALLOW_CUSTOM_BASE_URL/);
  });
});
