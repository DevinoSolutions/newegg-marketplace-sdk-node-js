/**
 * Example — read a price and PREVIEW a price change with `@devino/newegg-marketplace-sdk`.
 *
 * What it does:
 *   1. Reads Newegg credentials from the environment (fails fast; never prints their values).
 *   2. Reads the item's current price (`client.pricing.get`).
 *   3. Previews a selling-price change (`client.pricing.previewUpdate`): current vs new price,
 *      percent change, blockers and warnings. Nothing is sent to Newegg.
 *
 * This example NEVER calls `client.pricing.update` — that call writes a real selling price.
 * To apply a reviewed plan, do it deliberately in your own code (or through the MCP
 * preview -> apply flow with NEWEGG_MCP_ALLOW_WRITES=true).
 *
 * Run:
 *   NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
 *   NEWEGG_CREDENTIALS_MARKETPLACE=us \
 *     npm run start -w example-sdk-pricing-preview
 *
 * Optional: EXAMPLE_SELLER_PART_NUMBER (default YOUR-SKU), EXAMPLE_NEW_PRICE (default 19.99).
 */
import {
  createNeweggClient,
  NeweggError,
  type NeweggMarketplace,
  type PriceUpdate,
} from "@devino/newegg-marketplace-sdk";

/** Accept us | b2b | ca (case-insensitive); the Newegg `can` prefix maps to `ca`. */
function parseMarketplace(raw: string): NeweggMarketplace {
  const normalized = raw.trim().toLowerCase();
  const value = normalized === "can" ? "ca" : normalized;
  if (value === "us" || value === "b2b" || value === "ca") {
    return value;
  }
  throw new Error('NEWEGG_MARKETPLACE must be one of: us, b2b, ca (the "can" alias maps to ca).');
}

async function main(): Promise<void> {
  const sellerId = process.env.NEWEGG_SELLER_ID;
  const apiKey = process.env.NEWEGG_API_KEY;
  const secretKey = process.env.NEWEGG_SECRET_KEY;
  const marketplaceRaw = process.env.NEWEGG_MARKETPLACE;
  // The marketplace the keys were issued for. Newegg ignores the URL prefix, so unlabeled keys would
  // silently serve another marketplace's account (ADR 0006).
  const credentialMarketplaceRaw = process.env.NEWEGG_CREDENTIALS_MARKETPLACE;

  // Report the NAMES of missing variables only — never their values.
  if (!sellerId || !apiKey || !secretKey || !marketplaceRaw || !credentialMarketplaceRaw) {
    const missing = (
      [
        ["NEWEGG_SELLER_ID", sellerId],
        ["NEWEGG_API_KEY", apiKey],
        ["NEWEGG_SECRET_KEY", secretKey],
        ["NEWEGG_MARKETPLACE", marketplaceRaw],
        ["NEWEGG_CREDENTIALS_MARKETPLACE", credentialMarketplaceRaw],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    console.error("See .env.example for the full list. Never commit real credentials.");
    process.exit(1);
  }

  const marketplace = parseMarketplace(marketplaceRaw);
  const client = createNeweggClient({
    sellerId,
    apiKey,
    secretKey,
    marketplace,
    credentialMarketplace: parseMarketplace(credentialMarketplaceRaw),
  });

  const sellerPartNumber = process.env.EXAMPLE_SELLER_PART_NUMBER ?? "YOUR-SKU";
  const newPrice = Number.parseFloat(process.env.EXAMPLE_NEW_PRICE ?? "19.99");
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    console.error("EXAMPLE_NEW_PRICE must be a positive number.");
    process.exit(1);
  }

  const identifier = { type: "sellerPartNumber", value: sellerPartNumber } as const;

  // US prices are per destination country and need countryCode + currency; B2B/CA reject both.
  const update: PriceUpdate =
    marketplace === "us"
      ? { identifier, sellingPrice: newPrice, countryCode: "USA", currency: "USD" }
      : { identifier, sellingPrice: newPrice };

  try {
    // 1. Current price (read).
    const snapshot = await client.pricing.get(
      marketplace === "us" ? { identifier, countries: ["USA"] } : { identifier },
    );
    console.log(`prices for ${sellerPartNumber}:`);
    for (const entry of snapshot.prices) {
      console.log(
        `  ${entry.countryCode ?? marketplace} ${entry.currency ?? "?"} active=${entry.active ?? "?"}`,
      );
    }

    // 2. Preview only. Reads the current price again and risk-checks the change; no write.
    const preview = await client.pricing.previewUpdate([update]);
    for (const change of preview.changes) {
      console.log(
        `\npreview: ${change.currentSellingPrice ?? "?"} -> ${change.newSellingPrice} ` +
          `(${change.changePercent?.toFixed(1) ?? "?"}%) status=${change.status}`,
      );
      for (const blocker of change.blockers) {
        console.log(`  blocker: ${blocker}`);
      }
      for (const warning of change.warnings) {
        console.log(`  warning: ${warning}`);
      }
    }
    console.log("\nNo write performed. This example never calls client.pricing.update.");
  } catch (error) {
    if (error instanceof NeweggError) {
      console.error("\nNewegg SDK error:");
      console.error(`  code:          ${error.code}`);
      console.error(`  message:       ${error.message}`);
      console.error(`  retryable:     ${error.retryable}`);
      console.error(`  correlationId: ${error.correlationId ?? "(none)"}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
