import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createNeweggClient,
  type ItemIdentifier,
  type NeweggClient,
  type NeweggMarketplace,
} from "../../src/index.js";

/**
 * Shared setup for the opt-in, READ-ONLY live suite. Loads the repo-root `.env` into
 * `process.env` (no dependency; never overwrites already-set vars, never logs values) so the
 * suite runs straight from the project's `.env` once `NEWEGG_LIVE_TESTS=true` is set.
 *
 * SAFETY: nothing in the live suite performs a write. Only `verifyCredentials`,
 * `service.getStatus`, `inventory.getItem`, `inventory.getMany` (reads), and a read-only
 * order-info query (used purely to discover a real SKU) are ever issued.
 */
function loadDotEnv(): void {
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      for (const raw of readFileSync(candidate, "utf8").split(/\r?\n/)) {
        const match = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        const key = match?.[1];
        const value = match?.[2];
        if (key === undefined || value === undefined) continue;
        if (process.env[key] === undefined) {
          process.env[key] = value.replace(/^\s*["']|["']\s*$/g, "").trim();
        }
      }
      return;
    }
    dir = resolve(dir, "..");
  }
}

loadDotEnv();

const env = process.env;

/** Read-only live suite runs only when explicitly enabled AND credentials are present. */
export const liveEnabled =
  env.NEWEGG_LIVE_TESTS === "true" &&
  Boolean(env.NEWEGG_SELLER_ID) &&
  Boolean(env.NEWEGG_API_KEY) &&
  Boolean(env.NEWEGG_SECRET_KEY);

export function marketplace(): NeweggMarketplace {
  const value = env.NEWEGG_MARKETPLACE?.toLowerCase();
  return value === "b2b" || value === "ca" ? value : "us";
}

export function makeLiveClient(): NeweggClient {
  return createNeweggClient({
    sellerId: String(env.NEWEGG_SELLER_ID),
    apiKey: String(env.NEWEGG_API_KEY),
    secretKey: String(env.NEWEGG_SECRET_KEY),
    marketplace: marketplace(),
    ...(env.NEWEGG_API_BASE_URL ? { baseUrl: env.NEWEGG_API_BASE_URL } : {}),
  });
}

/** US-only warehouse code for reads; undefined (and ignored) for B2B/CA. */
export function testWarehouse(): string | undefined {
  return env.NEWEGG_LIVE_TEST_WAREHOUSE ? String(env.NEWEGG_LIVE_TEST_WAREHOUSE) : undefined;
}

function marketplacePrefix(): string {
  const m = marketplace();
  return m === "b2b" ? "b2b/" : m === "ca" ? "can/" : "";
}

/**
 * Best-effort READ-ONLY discovery of a real item identifier for inventory-read tests. Prefers
 * an explicit `NEWEGG_LIVE_TEST_SELLER_PART_NUMBER`; otherwise reads recent orders (order-info
 * is a read despite the PUT verb) and returns the first SellerPartNumber found. Returns
 * `undefined` on any failure so tests skip cleanly instead of failing. Never writes.
 */
export async function discoverIdentifiers(limit = 5): Promise<ItemIdentifier[]> {
  const explicit = env.NEWEGG_LIVE_TEST_SELLER_PART_NUMBER;
  if (explicit) return [{ type: "sellerPartNumber", value: explicit }];

  const body = JSON.stringify({
    OperationType: "GetOrderInfoRequest",
    RequestBody: {
      PageIndex: 1,
      PageSize: 20,
      RequestCriteria: {
        OrderDateFrom: "01/01/2025 00:00:00",
        OrderDateTo: "12/31/2026 23:59:59",
      },
    },
  });

  for (const version of ["304", ""]) {
    const url =
      `https://api.newegg.com/marketplace/${marketplacePrefix()}ordermgmt/order/orderinfo` +
      `?sellerid=${env.NEWEGG_SELLER_ID}${version ? `&version=${version}` : ""}`;
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: String(env.NEWEGG_API_KEY),
          SecretKey: String(env.NEWEGG_SECRET_KEY),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      });
      if (!res.ok) continue;
      const text = await res.text();
      const skus = [...text.matchAll(/"SellerPartNumber"\s*:\s*"([^"]+)"/g)]
        .map((m) => m[1])
        .filter((v): v is string => Boolean(v));
      const distinct = [...new Set(skus)].slice(0, limit);
      if (distinct.length) return distinct.map((value) => ({ type: "sellerPartNumber", value }));
    } catch {
      // best-effort: try the next version, else give up and let the test skip
    }
  }
  return [];
}
