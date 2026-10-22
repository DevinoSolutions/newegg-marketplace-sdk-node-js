import { describe, expect, it } from "vitest";
import { loadMcpConfigFromEnv, McpConfigError } from "../src/index.js";
import { makeEnv } from "./helpers.js";

// T-5672 (L8): the HTTP bearer token needs a minimum strength.

const tokenOf = (length: number): string => "t".repeat(length);

function loadWithToken(token: string | undefined) {
  return loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_HTTP_BEARER_TOKEN: token }));
}

describe("HTTP session bounds and TLS-proxy declaration (T-5670 / T-5672)", () => {
  it("defaults to 32 sessions, a 30 minute idle timeout and no TLS-proxy declaration", () => {
    const { http } = loadMcpConfigFromEnv(makeEnv());
    expect(http.maxSessions).toBe(32);
    expect(http.sessionIdleTtlSeconds).toBe(1800);
    expect(http.behindTlsProxy).toBe(false);
  });

  it("reads the overrides and accepts only the exact literal true for the proxy flag", () => {
    const { http } = loadMcpConfigFromEnv(
      makeEnv({
        NEWEGG_MCP_HTTP_MAX_SESSIONS: "4",
        NEWEGG_MCP_HTTP_SESSION_IDLE_SECONDS: "90",
        NEWEGG_MCP_HTTP_BEHIND_TLS_PROXY: "true",
      }),
    );
    expect([http.maxSessions, http.sessionIdleTtlSeconds, http.behindTlsProxy]).toEqual([
      4,
      90,
      true,
    ]);
    expect(
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_HTTP_BEHIND_TLS_PROXY: "TRUE" })).http
        .behindTlsProxy,
    ).toBe(false);
  });

  it("rejects a zero or non-numeric session bound", () => {
    expect(() => loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_HTTP_MAX_SESSIONS: "0" }))).toThrow(
      McpConfigError,
    );
    expect(() =>
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_HTTP_SESSION_IDLE_SECONDS: "soon" })),
    ).toThrow(McpConfigError);
  });
});

describe("plaintext report FTP escape hatch (T-5668)", () => {
  it("is off by default and on only for the exact literal true", () => {
    expect(loadMcpConfigFromEnv(makeEnv()).allowPlaintextReportFtp).toBe(false);
    expect(
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_PLAINTEXT_REPORT_FTP: "1" }))
        .allowPlaintextReportFtp,
    ).toBe(false);
    expect(
      loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_PLAINTEXT_REPORT_FTP: "true" }))
        .allowPlaintextReportFtp,
    ).toBe(true);
  });
});

describe("HTTP bearer token strength (T-5672 / L8)", () => {
  it("rejects a 31-character token without echoing it", () => {
    const weak = tokenOf(31);
    let thrown: unknown;
    try {
      loadWithToken(weak);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpConfigError);
    expect((thrown as Error).message).toContain("NEWEGG_MCP_HTTP_BEARER_TOKEN");
    expect((thrown as Error).message).toContain("32");
    expect((thrown as Error).message).not.toContain(weak);
  });

  it("accepts a 32-character token", () => {
    expect(loadWithToken(tokenOf(32)).http.bearerToken).toBe(tokenOf(32));
  });

  it("still treats an unset or blank token as no token", () => {
    expect(loadWithToken(undefined).http.bearerToken).toBeUndefined();
    expect(loadWithToken("   ").http.bearerToken).toBeUndefined();
  });
});
