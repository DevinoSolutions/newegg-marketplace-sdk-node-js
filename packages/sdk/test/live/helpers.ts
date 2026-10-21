import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createNeweggClient,
  NeweggError,
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

/**
 * CA is the strict reference marketplace: every live check must pass there. On US/B2B a few reads
 * hit documented Newegg-side limitations (see `skipNonCaLimitation`); those skip with a reason
 * instead of failing, and CA never skips them.
 */
export function isCa(): boolean {
  return marketplace() === "ca";
}

/** A documented, Newegg-side limitation of a read that is tolerated on non-CA marketplaces only. */
export interface NonCaLimitation {
  reason: string;
  matches: (error: NeweggError) => boolean;
}

/**
 * Skips the current test (never fails it) when `error` is a documented non-CA limitation. Returns
 * normally on CA and for any other error, so the caller rethrows. `ctx.skip` throws, so call this
 * from a `catch` block, immediately before `throw error`.
 */
export function skipNonCaLimitation(
  ctx: { skip: (note?: string) => never },
  error: unknown,
  limitation: NonCaLimitation,
): void {
  if (isCa()) return;
  if (error instanceof NeweggError && limitation.matches(error)) {
    ctx.skip(`${marketplace()}: ${limitation.reason}`);
  }
}

/**
 * Batch inventory read on US/B2B answers 401 InvalidToken ("Illegal secret key") on the
 * `international/inventorylist` route only, while the same credentials read single inventory,
 * price and order-info fine (observed live 2026-10-21, T-5611; contracts section 5.3).
 */
export const NON_CA_BATCH_INVENTORY_401: NonCaLimitation = {
  reason:
    "batch inventory read answers 401 InvalidToken (Newegg-side; per-marketplace key is an ASSUMPTION; T-5611)",
  matches: (error) => error.httpStatus === 401 && error.neweggErrorCode === "InvalidToken",
};

/**
 * Get Volume Discount answers HTTP 500 InternalError for a real SKU on US/B2B (unknown SKU: clean
 * 400 CT002; CA: 400 CT060). Observed live 2026-10-21, T-5611; contracts section 22.1.
 */
export const NON_CA_VOLUME_DISCOUNT_500: NonCaLimitation = {
  reason: "Get Volume Discount answers HTTP 500 InternalError for a real SKU (Newegg-side; T-5611)",
  matches: (error) => error.httpStatus === 500 && error.neweggErrorCode === "InternalError",
};

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

/**
 * Best-effort READ-ONLY discovery of real item identifiers for inventory-read tests. Prefers an
 * explicit `NEWEGG_LIVE_TEST_SELLER_PART_NUMBER`; otherwise dogfoods the SDK — `orders.list`
 * reads recent orders (order-info is a read despite the PUT verb) and returns the distinct
 * SellerPartNumbers found on their line items. On US/B2B the candidates are filtered to items
 * that exist on that marketplace. TODO(T-5611): discover per-marketplace identifiers from the Item
 * Basic Info report instead of order lines. Returns `[]` on any failure so tests skip cleanly
 * instead of failing. Never writes. Going through `makeLiveClient()` means discovery honors
 * `NEWEGG_API_BASE_URL` (fixture-server mode) for free, unlike the old hardcoded-base raw fetch.
 */
export async function discoverIdentifiers(limit = 5): Promise<ItemIdentifier[]> {
  const explicit = env.NEWEGG_LIVE_TEST_SELLER_PART_NUMBER;
  if (explicit) return [{ type: "sellerPartNumber", value: explicit }];

  try {
    const client = makeLiveClient();
    const page = await client.orders.list({
      dateFrom: "01/01/2020 00:00:00",
      dateTo: "12/31/2026 23:59:59",
      pageSize: 20,
    });
    const skus = page.orders
      .flatMap((order) => order.items)
      .map((item) => item.sellerPartNumber)
      .filter((value): value is string => Boolean(value));
    const distinct = [...new Set(skus)].slice(0, limit);
    const candidates = distinct.map((value): ItemIdentifier => ({
      type: "sellerPartNumber",
      value,
    }));
    if (isCa()) return candidates;
    // Order-info answers with the same CA-store orders under the us/ and b2b/ prefixes, and a
    // B2B inventory read of an item that does not exist there is an empty 200 shell, so keep only
    // items a read-only price read finds on THIS marketplace (T-5611).
    const existing: ItemIdentifier[] = [];
    for (const identifier of candidates) {
      if ((await client.pricing.tryGet({ identifier })) !== undefined) existing.push(identifier);
    }
    return existing;
  } catch {
    // best-effort: let the inventory-read tests skip if no identifier can be discovered
    return [];
  }
}
