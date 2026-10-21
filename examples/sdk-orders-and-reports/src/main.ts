/**
 * Example — read-only orders and reports with `@devino/newegg-marketplace-sdk`.
 *
 * What it does:
 *   1. Reads Newegg credentials from the environment (fails fast; never prints their values).
 *   2. Lists unshipped orders (`client.orders.list`) — order number, status and item count only;
 *      the customer block (PII) is never printed.
 *   3. Fetches the Settlement Summary report for a date range (`client.reports.settlementSummary`).
 *
 * Every call here is a read. `orders.ship` / `cancel` / `confirmDownload` / `removeItems` are
 * writes and are deliberately not used. Settlement reports can take a few minutes to generate.
 *
 * Run:
 *   NEWEGG_SELLER_ID=... NEWEGG_API_KEY=... NEWEGG_SECRET_KEY=... NEWEGG_MARKETPLACE=us \
 *   NEWEGG_CREDENTIALS_MARKETPLACE=us \
 *     npm run start -w example-sdk-orders-and-reports
 *
 * Optional: EXAMPLE_SETTLEMENT_FROM / EXAMPLE_SETTLEMENT_TO (YYYY-MM-DD, default: last 30 days).
 */
import {
  createNeweggClient,
  NeweggError,
  type NeweggMarketplace,
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

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
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

  const client = createNeweggClient({
    sellerId,
    apiKey,
    secretKey,
    marketplace: parseMarketplace(marketplaceRaw),
    credentialMarketplace: parseMarketplace(credentialMarketplaceRaw),
  });

  const now = new Date();
  const dateTo = process.env.EXAMPLE_SETTLEMENT_TO ?? isoDate(now);
  const dateFrom =
    process.env.EXAMPLE_SETTLEMENT_FROM ?? isoDate(new Date(now.getTime() - 30 * 86_400_000));

  try {
    // 1. Unshipped orders (a read, even though Newegg exposes it as a PUT).
    const page = await client.orders.list({ status: "unshipped", page: 1, pageSize: 10 });
    console.log(`unshipped orders: ${page.totalCount} total, showing ${page.orders.length}`);
    for (const order of page.orders) {
      console.log(
        `  ${order.orderNumber} status=${order.status} items=${order.items.length} ` +
          `ordered=${order.orderDate?.iso ?? order.orderDate?.raw ?? "?"}`,
      );
    }

    // 2. Settlement Summary for the range. Newegg can take ~3 minutes; waitForResult polls and
    //    throws ReportTimeoutError (carrying the requestId) rather than hanging forever.
    console.log(`\nsettlement summary ${dateFrom} .. ${dateTo} (this can take a few minutes)`);
    const report = await client.reports.settlementSummary.waitForResult({ dateFrom, dateTo });
    console.log(`settlements: ${report.totalCount} (fetched ${report.rows.length})`);
    for (const row of report.rows) {
      console.log(
        `  ${row.settlementId ?? "?"} ${row.settlementDateFrom?.iso ?? row.settlementDateFrom?.raw ?? "?"}` +
          ` .. ${row.settlementDateTo?.iso ?? row.settlementDateTo?.raw ?? "?"}`,
      );
    }
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
