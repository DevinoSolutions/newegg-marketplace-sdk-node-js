import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNeweggMcpServer, loadMcpConfigFromEnv, McpConfigError } from "../src/index.js";
import { makeEnv } from "./helpers.js";

// T-5672 (L8): the HTTP bearer token needs a minimum strength.

const tokenOf = (length: number): string =>
  "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, length).padEnd(length, "x");

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

describe("report FTPS opt-in (T-5668)", () => {
  it("is off by default and on only for the exact literal true", () => {
    expect(loadMcpConfigFromEnv(makeEnv()).reportFtps).toBe(false);
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_REPORT_FTPS: "1" })).reportFtps).toBe(false);
    expect(loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_REPORT_FTPS: "true" })).reportFtps).toBe(true);
  });

  const dir = mkdtempSync(join(tmpdir(), "ftps-ca-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const pem = ["-----BEGIN CERTIFICATE-----", "MIIBtestonly", "-----END CERTIFICATE-----", ""].join(
    "\n",
  );
  const pemFile = join(dir, "server.pem");
  writeFileSync(pemFile, pem);

  it("validates the pinned certificate fingerprint without echoing it", () => {
    const pin = "ab".repeat(32);
    const config = loadMcpConfigFromEnv(
      makeEnv({
        NEWEGG_MCP_REPORT_FTPS: "true",
        NEWEGG_MCP_REPORT_FTPS_CERT_SHA256: pin,
        NEWEGG_MCP_REPORT_FTPS_CA_FILE: pemFile,
      }),
    );
    expect(config.reportFtpsCertSha256).toBe(pin);
    expect(config.reportFtpsCa).toBe(pem);
    expect(() =>
      loadMcpConfigFromEnv(
        makeEnv({
          NEWEGG_MCP_REPORT_FTPS: "true",
          NEWEGG_MCP_REPORT_FTPS_CERT_SHA256: "not-a-fingerprint",
          NEWEGG_MCP_REPORT_FTPS_CA_FILE: pemFile,
        }),
      ),
    ).toThrow(McpConfigError);
  });

  it("refuses a pin without the certificate PEM, since validation is never disabled", () => {
    expect(() =>
      loadMcpConfigFromEnv(
        makeEnv({
          NEWEGG_MCP_REPORT_FTPS: "true",
          NEWEGG_MCP_REPORT_FTPS_CERT_SHA256: "ab".repeat(32),
        }),
      ),
    ).toThrow(/NEWEGG_MCP_REPORT_FTPS_CA_FILE/);
  });

  it("refuses a pin or CA file without NEWEGG_MCP_REPORT_FTPS=true instead of staying plain FTP", () => {
    for (const extra of [
      {
        NEWEGG_MCP_REPORT_FTPS_CERT_SHA256: "ab".repeat(32),
        NEWEGG_MCP_REPORT_FTPS_CA_FILE: pemFile,
      },
      { NEWEGG_MCP_REPORT_FTPS_CA_FILE: pemFile },
      { NEWEGG_MCP_REPORT_FTPS: "1", NEWEGG_MCP_REPORT_FTPS_CA_FILE: pemFile },
    ]) {
      let thrown: unknown;
      try {
        loadMcpConfigFromEnv(makeEnv(extra));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpConfigError);
      expect((thrown as Error).message).toContain("NEWEGG_MCP_REPORT_FTPS=true");
    }
  });

  it("rejects an unreadable or non-PEM CA file without echoing its content", () => {
    const junk = join(dir, "junk.txt");
    writeFileSync(junk, "SECRET-LOOKING-CONTENT");
    for (const path of [junk, join(dir, "missing.pem")]) {
      let thrown: unknown;
      try {
        loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_REPORT_FTPS_CA_FILE: path }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpConfigError);
      expect((thrown as Error).message).toContain("NEWEGG_MCP_REPORT_FTPS_CA_FILE");
      expect((thrown as Error).message).not.toContain("SECRET-LOOKING-CONTENT");
    }
  });

  it("never drops a pin silently when a hand-built config forgets reportFtps", () => {
    const config = loadMcpConfigFromEnv(makeEnv());
    expect(() =>
      createNeweggMcpServer({ config: { ...config, reportFtpsCertSha256: "ab".repeat(32) } }),
    ).toThrow(/refusing to fall back to plain FTP/);
    expect(() => createNeweggMcpServer({ config: { ...config, reportFtpsCa: pem } })).toThrow(
      /refusing to fall back to plain FTP/,
    );
  });

  it("exposes the PEM and the pin for the SDK client config", () => {
    const config = loadMcpConfigFromEnv(
      makeEnv({
        NEWEGG_MCP_REPORT_FTPS: "true",
        NEWEGG_MCP_REPORT_FTPS_CERT_SHA256: "ab".repeat(32),
        NEWEGG_MCP_REPORT_FTPS_CA_FILE: pemFile,
      }),
    );
    expect(config.reportFtps).toBe(true);
    expect([config.reportFtpsCertSha256, config.reportFtpsCa]).toEqual(["ab".repeat(32), pem]);
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

  it.each([
    ["a single repeated character", "a".repeat(40)],
    ["two alternating characters", "ab".repeat(20)],
    ["eleven distinct characters", "abcdefghijk".repeat(4)],
  ])("rejects a long but trivially weak token: %s", (_label, weak) => {
    let thrown: unknown;
    try {
      loadWithToken(weak);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpConfigError);
    expect((thrown as Error).message).toContain("NEWEGG_MCP_HTTP_BEARER_TOKEN");
    expect((thrown as Error).message).toContain("predictable");
    expect((thrown as Error).message).not.toContain(weak);
  });

  it("accepts a hex token from openssl rand -hex 32 and a base64 one from openssl rand -base64 32", () => {
    const hex = "9f2c4e6a1b7d3085c2e49a6f01d8b37e5a4c9d20f6b18e73a0c5d4b92e6f1a37";
    expect(loadWithToken(hex).http.bearerToken).toBe(hex);
    const base64 = "q3Vn7mZs0Xb9Lk2Yt4RwHc8EaJd5PfUo1GiN6TyBxvM=";
    expect(loadWithToken(base64).http.bearerToken).toBe(base64);
  });

  it("accepts a random 32-character token", () => {
    const token = "9f2c4e6a1b7d3085c2e49a6f01d8b37e";
    expect(loadWithToken(token).http.bearerToken).toBe(token);
  });

  it("still treats an unset or blank token as no token", () => {
    expect(loadWithToken(undefined).http.bearerToken).toBeUndefined();
    expect(loadWithToken("   ").http.bearerToken).toBeUndefined();
  });
});

// T-6216: the preview TTL, item cap and HTTP port parse as strict plain decimals with upper bounds
// (`Number()` accepted "1e9" = a 31.7 year preview, "1e300" = an Invalid Date, "0x10", "+5").
describe("strict numeric env limits (T-6216)", () => {
  const cases = [
    {
      name: "NEWEGG_MCP_PREVIEW_TTL_SECONDS",
      bad: ["1e9", "0x10", "86401", "+5", "-1", "1.5", " 1 2 ", "0", "007"],
      good: "86400",
      read: (c: ReturnType<typeof loadMcpConfigFromEnv>) => c.limits.previewTtlSeconds,
      fallback: 600,
    },
    {
      name: "NEWEGG_MCP_MAX_ITEMS_PER_OPERATION",
      bad: ["1e9", "0x10", "10001", "+5", "-1", "1.5", "1 2", "0", "007"],
      good: "10000",
      read: (c: ReturnType<typeof loadMcpConfigFromEnv>) => c.limits.maxItemsPerOperation,
      fallback: 500,
    },
    {
      name: "NEWEGG_MCP_HTTP_PORT",
      bad: ["0x50", "8e3", "65536", "0", "+80", "-1", "80.5", "8 0", "08080"],
      good: "65535",
      read: (c: ReturnType<typeof loadMcpConfigFromEnv>) => c.http.port,
      fallback: 3919,
    },
  ];

  for (const { name, bad, good, read, fallback } of cases) {
    describe(name, () => {
      for (const value of bad) {
        it(`rejects ${JSON.stringify(value)} naming the variable and range`, () => {
          let error: unknown;
          try {
            loadMcpConfigFromEnv(makeEnv({ [name]: value }));
          } catch (e) {
            error = e;
          }
          expect(error).toBeInstanceOf(McpConfigError);
          expect(String((error as Error).message)).toContain(name);
        });
      }

      it("rejects 1e300 without throwing a RangeError later", () => {
        expect(() => loadMcpConfigFromEnv(makeEnv({ [name]: "1e300" }))).toThrow(McpConfigError);
      });

      it("accepts the upper bound, trims whitespace, and keeps the default when unset or empty", () => {
        expect(read(loadMcpConfigFromEnv(makeEnv({ [name]: good })))).toBe(Number(good));
        expect(read(loadMcpConfigFromEnv(makeEnv({ [name]: ` ${good} ` })))).toBe(Number(good));
        expect(read(loadMcpConfigFromEnv(makeEnv()))).toBe(fallback);
        expect(read(loadMcpConfigFromEnv(makeEnv({ [name]: "" })))).toBe(fallback);
      });
    });
  }
});
