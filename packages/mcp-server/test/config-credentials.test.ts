import { describe, expect, it } from "vitest";
import {
  NeweggConfigurationError,
  NeweggMarketplaceMismatchError,
} from "@devino/newegg-marketplace-sdk";
import { createNeweggMcpServer, loadMcpConfigFromEnv, McpConfigError } from "../src/index.js";
import type { EnvRecord, McpServerConfig } from "../src/index.js";
import { SENTINELS } from "./helpers.js";

/** Distinct sentinels per marketplace so a cross-marketplace fallback is detectable. */
function setFor(marketplace: "US" | "B2B" | "CA"): EnvRecord {
  return {
    [`NEWEGG_${marketplace}_SELLER_ID`]: `SELLER-${marketplace}-SENTINEL`,
    [`NEWEGG_${marketplace}_API_KEY`]: `APIKEY-${marketplace}-SENTINEL-XXXXXXXXXX`,
    [`NEWEGG_${marketplace}_SECRET_KEY`]: `SECRET-${marketplace}-SENTINEL`,
  };
}

const LEGACY: EnvRecord = {
  NEWEGG_SELLER_ID: SENTINELS.sellerId,
  NEWEGG_API_KEY: SENTINELS.apiKey,
  NEWEGG_SECRET_KEY: SENTINELS.secretKey,
};

function failure(env: EnvRecord): string {
  try {
    loadMcpConfigFromEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(McpConfigError);
    return (error as Error).message;
  }
  throw new Error("expected loadMcpConfigFromEnv to throw");
}

function expectNoSecrets(message: string): void {
  for (const secret of [SENTINELS.sellerId, SENTINELS.apiKey, SENTINELS.secretKey, "SENTINEL"]) {
    expect(message).not.toContain(secret);
  }
}

describe("MCP credential binding (T-5911)", () => {
  for (const marketplace of ["us", "b2b", "ca"] as const) {
    it(`uses the complete NEWEGG_${marketplace.toUpperCase()}_* set for ${marketplace}`, () => {
      const config = loadMcpConfigFromEnv({
        NEWEGG_MARKETPLACE: marketplace,
        ...setFor(marketplace.toUpperCase() as "US" | "B2B" | "CA"),
      });
      expect(config.marketplace).toBe(marketplace);
      expect(config.credentialMarketplace).toBe(marketplace);
      expect(config.credentials.sellerId).toBe(`SELLER-${marketplace.toUpperCase()}-SENTINEL`);
      expect(config.credentials.secretKey).toBe(`SECRET-${marketplace.toUpperCase()}-SENTINEL`);
    });
  }

  it("selects the set of the chosen marketplace when several are present", () => {
    const config = loadMcpConfigFromEnv({
      NEWEGG_MARKETPLACE: "us",
      ...setFor("CA"),
      ...setFor("US"),
      ...setFor("B2B"),
    });
    expect(config.credentials.apiKey).toBe("APIKEY-US-SENTINEL-XXXXXXXXXX");
  });

  it("reports a partial prefixed set in one aggregated message without values", () => {
    const message = failure({
      NEWEGG_MARKETPLACE: "ca",
      NEWEGG_CA_SELLER_ID: "SELLER-CA-SENTINEL",
      ...LEGACY,
      NEWEGG_CREDENTIALS_MARKETPLACE: "ca",
    });
    expect(message).toContain("NEWEGG_CA_API_KEY");
    expect(message).toContain("NEWEGG_CA_SECRET_KEY");
    expect(message).not.toContain("SELLER-CA-SENTINEL");
    expectNoSecrets(message);
  });

  it("does not fall back to the legacy set when a prefixed set is partial", () => {
    expect(() =>
      loadMcpConfigFromEnv({
        NEWEGG_MARKETPLACE: "ca",
        NEWEGG_CA_API_KEY: "APIKEY-CA-SENTINEL-XXXXXXXXXX",
        ...LEGACY,
        NEWEGG_CREDENTIALS_MARKETPLACE: "ca",
      }),
    ).toThrow(McpConfigError);
  });

  it("accepts the legacy unprefixed set when NEWEGG_CREDENTIALS_MARKETPLACE matches", () => {
    for (const marketplace of ["us", "b2b", "ca"] as const) {
      const config = loadMcpConfigFromEnv({
        NEWEGG_MARKETPLACE: marketplace,
        NEWEGG_CREDENTIALS_MARKETPLACE: marketplace,
        ...LEGACY,
      });
      expect(config.credentialMarketplace).toBe(marketplace);
      expect(config.credentials.apiKey).toBe(SENTINELS.apiKey);
    }
  });

  it("accepts the 'can' alias for the credential marketplace", () => {
    const config = loadMcpConfigFromEnv({
      NEWEGG_MARKETPLACE: "CA",
      NEWEGG_CREDENTIALS_MARKETPLACE: "can",
      ...LEGACY,
    });
    expect(config.credentialMarketplace).toBe("ca");
  });

  it("refuses the legacy set without NEWEGG_CREDENTIALS_MARKETPLACE", () => {
    const message = failure({ NEWEGG_MARKETPLACE: "ca", ...LEGACY });
    expect(message).toContain("NEWEGG_CREDENTIALS_MARKETPLACE");
    expect(message).toContain("NEWEGG_CA_SELLER_ID");
    expectNoSecrets(message);
  });

  it("refuses the legacy set when NEWEGG_CREDENTIALS_MARKETPLACE is blank", () => {
    const message = failure({
      NEWEGG_MARKETPLACE: "ca",
      NEWEGG_CREDENTIALS_MARKETPLACE: "  ",
      ...LEGACY,
    });
    expect(message).toContain("NEWEGG_CREDENTIALS_MARKETPLACE");
  });

  it("refuses the legacy set when NEWEGG_CREDENTIALS_MARKETPLACE differs from NEWEGG_MARKETPLACE", () => {
    const message = failure({
      NEWEGG_MARKETPLACE: "us",
      NEWEGG_CREDENTIALS_MARKETPLACE: "ca",
      ...LEGACY,
    });
    expect(message).toContain("does not match");
    expect(message).toContain("refusing to start");
    expectNoSecrets(message);
  });

  it("rejects an unknown NEWEGG_CREDENTIALS_MARKETPLACE by name", () => {
    const message = failure({
      NEWEGG_MARKETPLACE: "ca",
      NEWEGG_CREDENTIALS_MARKETPLACE: "moon",
      ...LEGACY,
    });
    expect(message).toContain("NEWEGG_CREDENTIALS_MARKETPLACE");
    expect(message).not.toContain("moon");
  });

  it("reports the missing legacy variables by name when the legacy set is incomplete", () => {
    const message = failure({
      NEWEGG_MARKETPLACE: "ca",
      NEWEGG_CREDENTIALS_MARKETPLACE: "ca",
      NEWEGG_SELLER_ID: SENTINELS.sellerId,
    });
    expect(message).toContain("NEWEGG_API_KEY");
    expect(message).toContain("NEWEGG_SECRET_KEY");
    expectNoSecrets(message);
  });

  it("never falls back to another marketplace's prefixed set", () => {
    const message = failure({ NEWEGG_MARKETPLACE: "us", ...setFor("CA") });
    expect(message).toContain("NEWEGG_US_SELLER_ID");
    expect(message).toContain("ca");
    expect(message).not.toContain("SENTINEL");
  });

  it("does not let a legacy set labeled for another marketplace stand in for a prefixed one", () => {
    expect(() =>
      loadMcpConfigFromEnv({
        NEWEGG_MARKETPLACE: "b2b",
        NEWEGG_CREDENTIALS_MARKETPLACE: "ca",
        ...LEGACY,
        ...setFor("CA"),
      }),
    ).toThrow(McpConfigError);
  });

  it("reports no credentials at all with the exact variable names to set", () => {
    const message = failure({ NEWEGG_MARKETPLACE: "ca" });
    for (const name of ["NEWEGG_CA_SELLER_ID", "NEWEGG_CA_API_KEY", "NEWEGG_CA_SECRET_KEY"]) {
      expect(message).toContain(name);
    }
  });

  it("keeps the serialized config free of secrets and passes credentialMarketplace through", () => {
    const config = loadMcpConfigFromEnv({ NEWEGG_MARKETPLACE: "ca", ...setFor("CA") });
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("SENTINEL");
    expect(JSON.parse(serialized)).toMatchObject({ credentialMarketplace: "ca" });
  });

  it("passes credentialMarketplace to the SDK client it builds (no injected client)", async () => {
    const config = loadMcpConfigFromEnv({ NEWEGG_MARKETPLACE: "ca", ...setFor("CA") });
    // A matching binding builds fine; no request is made at construction.
    const ok = createNeweggMcpServer({ config });
    await ok.close();
    // The SDK re-checks the binding, so a config that disagrees is refused at construction.
    const skewed = { ...config, credentialMarketplace: "us" } as McpServerConfig;
    expect(() => createNeweggMcpServer({ config: skewed })).toThrow(NeweggMarketplaceMismatchError);
  });

  it("refuses a contradictory NEWEGG_CREDENTIALS_MARKETPLACE next to a complete prefixed set", () => {
    const message = failure({
      NEWEGG_MARKETPLACE: "us",
      NEWEGG_CREDENTIALS_MARKETPLACE: "ca",
      ...setFor("US"),
    });
    expect(message).toContain("NEWEGG_CREDENTIALS_MARKETPLACE (ca)");
    expect(message).toContain("NEWEGG_MARKETPLACE (us)");
    expect(message).not.toContain("SENTINEL");
  });

  it("rejects an invalid NEWEGG_CREDENTIALS_MARKETPLACE next to a prefixed set without echoing it", () => {
    const message = failure({
      NEWEGG_MARKETPLACE: "ca",
      NEWEGG_CREDENTIALS_MARKETPLACE: "moon",
      ...setFor("CA"),
    });
    expect(message).toContain("NEWEGG_CREDENTIALS_MARKETPLACE");
    expect(message).not.toContain("moon");
  });

  it("accepts a matching or blank NEWEGG_CREDENTIALS_MARKETPLACE next to a prefixed set", () => {
    for (const declared of ["us", "US", " ", undefined]) {
      const config = loadMcpConfigFromEnv({
        NEWEGG_MARKETPLACE: "us",
        NEWEGG_CREDENTIALS_MARKETPLACE: declared,
        ...setFor("US"),
      });
      expect(config.credentials.apiKey).toBe("APIKEY-US-SENTINEL-XXXXXXXXXX");
    }
  });

  it("reports both a partial prefixed set and a contradictory label in one message", () => {
    const message = failure({
      NEWEGG_MARKETPLACE: "us",
      NEWEGG_CREDENTIALS_MARKETPLACE: "ca",
      NEWEGG_US_API_KEY: "APIKEY-US-SENTINEL-XXXXXXXXXX",
    });
    expect(message).toContain("NEWEGG_US_SELLER_ID");
    expect(message).toContain("contradicts");
    expect(message).not.toContain("SENTINEL");
  });

  it("ignores a legacy set left next to a complete prefixed set (the prefixed set wins)", () => {
    const config = loadMcpConfigFromEnv({
      NEWEGG_MARKETPLACE: "ca",
      ...LEGACY,
      ...setFor("CA"),
    });
    expect(config.credentials.apiKey).toBe("APIKEY-CA-SENTINEL-XXXXXXXXXX");
  });

  it("fails closed when a hand-built config has no credentialMarketplace", () => {
    const config = loadMcpConfigFromEnv({ NEWEGG_MARKETPLACE: "us", ...setFor("US") });
    const { credentialMarketplace: _dropped, ...rest } = config;
    void _dropped;
    let thrown: unknown;
    try {
      createNeweggMcpServer({ config: rest as unknown as McpServerConfig });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NeweggConfigurationError);
    expect((thrown as Error).message).toContain("credentialMarketplace");
    expect(JSON.stringify(thrown)).not.toContain("SENTINEL");
  });
});
