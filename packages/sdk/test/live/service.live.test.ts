import { describe, expect, it } from "vitest";
import {
  createNeweggClient,
  NeweggAuthenticationError,
  type NeweggServiceDomain,
} from "../../src/index.js";
import { liveEnabled, makeLiveClient, marketplace } from "./helpers.js";

/**
 * READ-ONLY live tests: credential preflight + service status against the REAL Newegg API.
 * Excluded from the default `vitest` run; gated on `NEWEGG_LIVE_TESTS=true` + credentials.
 * No mutating call appears anywhere in this file.
 */
const DOMAINS: NeweggServiceDomain[] = [
  "contentmgmt",
  "ordermgmt",
  "datafeedmgmt",
  "servicemgmt",
  "reportmgmt",
  "sellermgmt",
  "sbnmgmt",
  "shippingservice",
];

describe.skipIf(!liveEnabled)("live (read-only): credentials + service status", () => {
  it("verifyCredentials() authenticates against the real API (fail-fast preflight)", async () => {
    const client = makeLiveClient();
    const check = await client.verifyCredentials();
    expect(check.ok).toBe(true);
    expect(check.marketplace).toBe(marketplace());
    expect(check.domain).toBe("contentmgmt");
    expect(typeof check.serviceAvailable).toBe("boolean");
    expect(typeof check.correlationId).toBe("string");
  });

  it("reads service status across ALL 8 domains (read-only GETs)", async () => {
    const client = makeLiveClient();
    for (const domain of DOMAINS) {
      const status = await client.service.getStatus(domain);
      expect(status.domain).toBe(domain);
      expect(status.marketplace).toBe(marketplace());
      expect(typeof status.available).toBe("boolean");
    }
  });

  it("verifyCredentials fails fast with a wrong Seller ID (real 401, read-only)", async () => {
    // Pairs the real key/secret with a bogus Seller ID — the exact class of misconfiguration
    // that produced `Gateway: Seller Auth failed.` The preflight must reject immediately.
    const bad = createNeweggClient({
      sellerId: "ZZZZ99",
      apiKey: String(process.env.NEWEGG_API_KEY),
      secretKey: String(process.env.NEWEGG_SECRET_KEY),
      marketplace: marketplace(),
    });
    await expect(bad.verifyCredentials()).rejects.toBeInstanceOf(NeweggAuthenticationError);
  });
});
