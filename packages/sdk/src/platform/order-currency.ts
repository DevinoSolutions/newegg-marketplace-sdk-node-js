/**
 * Defense-in-depth for credential/marketplace mix-ups (T-5911, ADR 0006). Newegg authenticates on
 * seller id + key pair only, so a key pair from another marketplace's seller account answers
 * every prefix with ITS OWN orders. The order currency is the one reliable tell in a response:
 * a CAN seller's orders are CAD, a Newegg.com / Business seller's are USD (the USD side is an
 * ASSUMPTION, contracts §10). The expected set lives on the platform adapter, so the API layer
 * carries no per-marketplace `if`s (ADR 0002). `credentialMarketplace` remains the primary,
 * fail-closed protection; this only catches a client built without it.
 */
import type { NeweggMarketplace } from "../types.js";
import { NeweggMarketplaceMismatchError } from "../errors/index.js";
import type { PlatformAdapter } from "./types.js";

/** Marketplace implied by an order currency, when that currency is unambiguous. */
function marketplaceForCurrency(currency: string): NeweggMarketplace | undefined {
  return currency === "CAD" ? "ca" : undefined;
}

/**
 * Throws {@link NeweggMarketplaceMismatchError} when a NON-EMPTY page of orders has a defined
 * currency on EVERY order and none of them is in the adapter's expected set. Empty pages, pages
 * where any order has no currency, and mixed pages pass: a single stray currency is not evidence
 * of a wrong account. The error carries marketplace names and a count only - never order numbers.
 */
export function assertOrdersMatchMarketplace(
  adapter: Pick<PlatformAdapter, "marketplace" | "expectedOrderCurrencies">,
  orders: ReadonlyArray<{ currencyCode?: string }>,
): void {
  if (orders.length === 0) return;
  const expected = adapter.expectedOrderCurrencies.map((code) => code.toUpperCase());
  const seen = new Set<string>();
  for (const order of orders) {
    const code = order.currencyCode?.trim().toUpperCase();
    if (!code) return;
    if (expected.includes(code)) return;
    seen.add(code);
  }
  const currencies = [...seen].sort();
  const sole = currencies.length === 1 ? currencies[0] : undefined;
  throw new NeweggMarketplaceMismatchError(
    `Every order returned for the "${adapter.marketplace}" marketplace is in ` +
      `${currencies.join("/")}, but its orders are ${expected.join("/")}. The credentials most ` +
      `likely belong to a different marketplace's seller account (Newegg authenticates on the ` +
      `key pair alone and ignores the URL prefix), so these orders are not this marketplace's. ` +
      `Set credentialMarketplace and use the keys issued for "${adapter.marketplace}".`,
    {
      expectedMarketplace: adapter.marketplace,
      actualMarketplace: sole === undefined ? undefined : marketplaceForCurrency(sole),
      details: {
        reason: "order_currency_mismatch",
        marketplace: adapter.marketplace,
        expectedCurrencies: expected,
        observedCurrencies: currencies,
        orderCount: orders.length,
      },
    },
  );
}
