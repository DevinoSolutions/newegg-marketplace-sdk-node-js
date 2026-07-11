/**
 * Example — batch inventory updates with `@devino/newegg-marketplace-sdk`.
 *
 * Builds ~25 inventory updates programmatically (including deliberate duplicates and a
 * zero-quantity entry), previews the resulting plan (deduplication, strategy, feed count),
 * and reads back the first few identifiers with `getMany`.
 *
 * It performs NO writes unless you explicitly set `RUN_WRITE_EXAMPLE=yes`, which arms the
 * guarded `updateMany` call near the end. That call mutates a REAL Newegg account.
 *
 * Run (read-only):
 *   NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
 *     npm run start -w example-sdk-batch-inventory
 */
import {
  createNeweggClient,
  INVENTORY_FEED_MAX_RECORDS,
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

/** Build one update. US requires a warehouse (ISO 3166-1 alpha-3); B2B/CA do not. */
function buildUpdate(
  sku: string,
  quantity: number,
  marketplace: NeweggMarketplace,
): InventoryUpdate {
  const identifier = { type: "sellerPartNumber", value: sku } as const;
  return marketplace === "us"
    ? { identifier, quantity, warehouseLocation: "USA" }
    : { identifier, quantity };
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

  const prefix = process.env.EXAMPLE_SKU_PREFIX ?? "EXAMPLE-SKU-";

  // 22 unique base items with distinct quantities.
  const updates: InventoryUpdate[] = [];
  for (let i = 1; i <= 22; i += 1) {
    const sku = `${prefix}${String(i).padStart(3, "0")}`;
    updates.push(buildUpdate(sku, 10 + i, marketplace));
  }
  // Two deliberate duplicates (same SKU + warehouse). Dedup keeps the LAST write:
  // `${prefix}001` becomes 999 and `${prefix}005` becomes 7.
  updates.push(buildUpdate(`${prefix}001`, 999, marketplace));
  updates.push(buildUpdate(`${prefix}005`, 7, marketplace));
  // One zero-quantity update. Quantity 0 is valid and meaningful (sets the item out of stock).
  updates.push(buildUpdate(`${prefix}023`, 0, marketplace));

  console.log(`Built ${updates.length} updates (2 duplicates + 1 zero-quantity).`);

  try {
    // Preview: validates every item, applies last-write-wins dedup, and chooses a strategy.
    const preview = await client.inventory.previewUpdate(updates);
    console.log(`\npreview:`);
    console.log(`  strategy:          ${preview.strategy}`);
    console.log(`  normalized (kept): ${preview.normalizedUpdates.length}`);
    console.log(`  plannedFeedCount:  ${preview.plannedFeedCount}`);
    console.log(`  zeroQuantityCount: ${preview.zeroQuantityCount}`);
    console.log(`  deduplicated groups: ${preview.deduplicated.length}`);
    for (const group of preview.deduplicated) {
      const dropped = group.droppedInputIndexes.map((index) => `#${index}`).join(", ");
      console.log(`    kept #${group.keptInputIndex}, dropped ${dropped}`);
    }
    if (preview.warnings.length > 0) {
      console.log(`  warnings: ${preview.warnings.join("; ")}`);
    }

    // Read back the first five normalized identifiers with a batch read.
    const identifiers = preview.normalizedUpdates.slice(0, 5).map((item) => item.identifier);
    const batch = await client.inventory.getMany(
      marketplace === "us" ? { identifiers, warehouses: ["USA"] } : { identifiers },
    );
    console.log(
      `\ngetMany: returned ${batch.items.length} of ${identifiers.length} requested; ` +
        `missing ${batch.missingIdentifiers.length}`,
    );
    for (const item of batch.items) {
      const label = item.sellerPartNumber ?? item.itemNumber ?? "?";
      console.log(`  ${label}: total=${item.totalAvailableQuantity}`);
    }

    /*
     * Feed chunking
     * -------------
     * A single Newegg inventory feed file holds at most INVENTORY_FEED_MAX_RECORDS (10,000)
     * records. The SDK splits larger operations into stable, in-input-order chunks and
     * submits one feed per chunk:
     *   - 10,000 records -> 1 feed
     *   - 10,001 records -> 2 feeds (10,000 + 1)
     *   - 25,000 records -> 3 feeds (10,000 + 10,000 + 5,000)
     * Under strategy "auto", batches larger than the client's autoFeedThreshold (default 8)
     * post-dedup items use the feed pipeline; smaller ones use direct updates.
     */
    console.log(
      `\nEach feed file holds up to ${INVENTORY_FEED_MAX_RECORDS} records; ` +
        `10,001 records would span two feeds.`,
    );

    // Write path — DISABLED by default. Enabling it MUTATES A REAL NEWEGG ACCOUNT.
    if (process.env.RUN_WRITE_EXAMPLE === "yes") {
      console.warn(
        "\n*** RUN_WRITE_EXAMPLE=yes — applying updates. THIS CHANGES REAL INVENTORY. ***",
      );
      const result = await client.inventory.updateMany(preview.normalizedUpdates, {
        strategy: "auto",
        waitForFeedCompletion: true,
      });
      console.log(
        `\noperation ${result.operationId}: strategy=${result.strategy} ` +
          `submitted=${result.submittedItemCount} accepted=${result.acceptedItemCount} ` +
          `failed=${result.failedItemCount} deduped=${result.deduplicatedItemCount}`,
      );
      if (result.feedJobs) {
        for (const job of result.feedJobs) {
          console.log(`  feed ${job.requestId}: status=${job.status} items=${job.itemCount}`);
        }
      }
      for (const item of result.items) {
        const code = item.errorCode ? ` (${item.errorCode})` : "";
        console.log(
          `  [#${item.inputIndex}] ${item.sellerPartNumber ?? "?"} qty=${item.quantity} -> ${item.status}${code}`,
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
