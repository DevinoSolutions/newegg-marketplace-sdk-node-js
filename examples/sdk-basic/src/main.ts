/**
 * Example — basic, read-only usage of `@devino/newegg-marketplace-sdk`.
 *
 * What it does:
 *   1. Reads Newegg credentials from the environment (fails fast; never prints their values).
 *   2. Checks the content-management service status.
 *   3. Reads a single item's inventory.
 *   4. Previews an inventory update — validates, dedups, and picks direct-vs-feed. No write.
 *
 * It performs NO writes unless you explicitly set `RUN_WRITE_EXAMPLE=yes`, which arms the
 * guarded `updateMany` call near the end. That call mutates a REAL Newegg account.
 *
 * Run (read-only):
 *   NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
 *     npm run start -w example-sdk-basic
 */
import {
  createNeweggClient,
  NeweggError,
  type InventoryUpdate,
  type NeweggMarketplace,
} from "@devino/newegg-marketplace-sdk";

/** Accept us | b2b | ca (case-insensitive); the Newegg `can` prefix maps to `ca`. */
function parseMarketplace(raw: string): NeweggMarketplace {
  const normalized = raw.trim().toLowerCase();
  const value = normalized === "can" ? "ca" : normalized;
  if (value === "us" || value === "b2b" || value === "ca") {
    return value;
  }
  throw new Error(
    'NEWEGG_MARKETPLACE must be one of: us, b2b, ca (the Newegg "can" alias maps to ca).',
  );
}

async function main(): Promise<void> {
  const sellerId = process.env.NEWEGG_SELLER_ID;
  const apiKey = process.env.NEWEGG_API_KEY;
  const secretKey = process.env.NEWEGG_SECRET_KEY;
  const marketplaceRaw = process.env.NEWEGG_MARKETPLACE;

  // Fail fast on missing configuration. Report the NAMES of the missing variables only —
  // never their values.
  if (!sellerId || !apiKey || !secretKey || !marketplaceRaw) {
    const missing = (
      [
        ["NEWEGG_SELLER_ID", sellerId],
        ["NEWEGG_API_KEY", apiKey],
        ["NEWEGG_SECRET_KEY", secretKey],
        ["NEWEGG_MARKETPLACE", marketplaceRaw],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    console.error("See .env.example for the full list. Never commit real credentials.");
    process.exit(1);
  }

  const marketplace = parseMarketplace(marketplaceRaw);
  const client = createNeweggClient({ sellerId, apiKey, secretKey, marketplace });

  const sellerPartNumber = process.env.EXAMPLE_SELLER_PART_NUMBER ?? "EXAMPLE-SKU";
  const quantity = Number.parseInt(process.env.EXAMPLE_QUANTITY ?? "5", 10);
  if (!Number.isInteger(quantity) || quantity < 0) {
    console.error("EXAMPLE_QUANTITY must be a non-negative integer.");
    process.exit(1);
  }

  const identifier = { type: "sellerPartNumber", value: sellerPartNumber } as const;

  // US inventory operations require a warehouse (ISO 3166-1 alpha-3); B2B/CA do not.
  const update: InventoryUpdate =
    marketplace === "us"
      ? { identifier, quantity, warehouseLocation: "USA" }
      : { identifier, quantity };

  try {
    // 1. Service status (defaults to the "contentmgmt" domain).
    const status = await client.service.getStatus();
    console.log(`service ${status.domain} on ${status.marketplace}: available=${status.available}`);
    if (status.message) {
      console.log(`  message: ${status.message}`);
    }

    // 2. Read one item's inventory.
    const snapshot = await client.inventory.getItem(
      marketplace === "us" ? { identifier, warehouses: ["USA"] } : { identifier },
    );
    console.log(`\ninventory for ${sellerPartNumber}: total=${snapshot.totalAvailableQuantity}`);
    for (const warehouse of snapshot.warehouses) {
      console.log(`  ${warehouse.location}: ${warehouse.quantity} (${warehouse.fulfillment})`);
    }

    // 3. Preview the update. This validates and plans the write without performing it.
    const preview = await client.inventory.previewUpdate([update]);
    console.log(
      `\npreview: strategy=${preview.strategy} plannedFeeds=${preview.plannedFeedCount} ` +
        `zeroQty=${preview.zeroQuantityCount} normalized=${preview.normalizedUpdates.length}`,
    );
    if (preview.warnings.length > 0) {
      console.log(`  warnings: ${preview.warnings.join("; ")}`);
    }

    // 4. Write path — DISABLED by default. Enabling it MUTATES A REAL NEWEGG ACCOUNT.
    if (process.env.RUN_WRITE_EXAMPLE === "yes") {
      console.warn(
        "\n*** RUN_WRITE_EXAMPLE=yes — applying the update. THIS CHANGES REAL INVENTORY. ***",
      );
      const result = await client.inventory.updateMany(preview.normalizedUpdates, {
        strategy: "auto",
        waitForFeedCompletion: true,
      });
      console.log(
        `update ${result.operationId}: submitted=${result.submittedItemCount} ` +
          `accepted=${result.acceptedItemCount} failed=${result.failedItemCount}`,
      );
      for (const item of result.items) {
        console.log(
          `  [#${item.inputIndex}] ${item.sellerPartNumber ?? "?"} qty=${item.quantity} -> ${item.status}`,
        );
      }
    } else {
      console.log(
        "\nWrite step skipped. Set RUN_WRITE_EXAMPLE=yes to run the mutating updateMany call.",
      );
    }
  } catch (error) {
    // Surface the SDK's typed error fields rather than a raw stack.
    if (error instanceof NeweggError) {
      console.error("\nNewegg SDK error:");
      console.error(`  code:            ${error.code}`);
      console.error(`  neweggErrorCode: ${error.neweggErrorCode ?? "(none)"}`);
      console.error(`  message:         ${error.message}`);
      console.error(`  retryable:       ${error.retryable}`);
      console.error(`  correlationId:   ${error.correlationId ?? "(none)"}`);
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
