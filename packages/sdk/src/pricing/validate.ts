import type { NeweggMarketplace, NormalizedPriceUpdate, PriceUpdate } from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import { priceUpdateSchema } from "../schemas/inputs.js";
import { PRICE_UPDATE_MAX_ITEMS } from "./constants.js";

/**
 * Validates a list of price updates (schema + per-marketplace rules) and returns them
 * normalized with their original input index. Throws {@link NeweggValidationError} listing
 * every issue, each with a path and the offending `inputIndex`. Nothing is clamped or
 * rounded: a price with more than 2 decimals is rejected, never silently altered.
 */
export function validatePriceUpdates(
  updates: PriceUpdate[],
  marketplace: NeweggMarketplace,
): NormalizedPriceUpdate[] {
  const issues: NeweggValidationIssue[] = [];
  if (updates.length === 0) {
    throw new NeweggValidationError("Price update validation failed.", [
      { path: "updates", message: "at least one price update is required" },
    ]);
  }
  if (updates.length > PRICE_UPDATE_MAX_ITEMS) {
    throw new NeweggValidationError("Price update validation failed.", [
      { path: "updates", message: `at most ${PRICE_UPDATE_MAX_ITEMS} price updates per call` },
    ]);
  }

  const normalized: NormalizedPriceUpdate[] = [];
  updates.forEach((update, inputIndex) => {
    const result = priceUpdateSchema.safeParse(update);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({ path: issue.path.join("."), message: issue.message, inputIndex });
      }
      return;
    }
    const value = result.data;
    if (marketplace === "us") {
      if (value.countryCode === undefined) {
        issues.push({
          path: "countryCode",
          message: "countryCode is required for US price updates",
          inputIndex,
        });
      }
      if (value.currency === undefined) {
        issues.push({
          path: "currency",
          message: "currency is required for US price updates (it must match the country)",
          inputIndex,
        });
      }
    } else {
      for (const field of ["countryCode", "currency"] as const) {
        if (value[field] !== undefined) {
          issues.push({
            path: field,
            message: `${field} is US-only; B2B/CA prices are single-market and currency is implied`,
            inputIndex,
          });
        }
      }
    }
    normalized.push({ ...value, inputIndex });
  });

  if (issues.length > 0) {
    throw new NeweggValidationError("Price update validation failed.", issues);
  }
  return normalized;
}

interface DedupResult {
  deduped: NormalizedPriceUpdate[];
  report: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }>;
  deduplicatedItemCount: number;
}

/** Last-write-wins on (identifier type+value+condition, country), keeping first-seen order. */
export function dedupePriceUpdates(updates: NormalizedPriceUpdate[]): DedupResult {
  const byKey = new Map<string, { kept: NormalizedPriceUpdate; dropped: number[] }>();
  const order: string[] = [];
  for (const update of updates) {
    const id = update.identifier;
    const key = JSON.stringify([
      id.type,
      id.value,
      id.type === "upc" ? (id.condition ?? "") : "",
      update.countryCode ?? "",
    ]);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { kept: update, dropped: [] });
      order.push(key);
    } else {
      existing.dropped.push(existing.kept.inputIndex);
      existing.kept = update;
    }
  }
  const deduped: NormalizedPriceUpdate[] = [];
  const report: DedupResult["report"] = [];
  let deduplicatedItemCount = 0;
  for (const key of order) {
    const entry = byKey.get(key);
    if (!entry) continue;
    deduped.push(entry.kept);
    if (entry.dropped.length > 0) {
      report.push({ keptInputIndex: entry.kept.inputIndex, droppedInputIndexes: entry.dropped });
      deduplicatedItemCount += entry.dropped.length;
    }
  }
  return { deduped, report, deduplicatedItemCount };
}
