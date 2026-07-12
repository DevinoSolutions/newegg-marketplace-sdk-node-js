import type {
  InventoryUpdateStrategy,
  NeweggMarketplace,
  NormalizedInventoryUpdate,
} from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import { INVENTORY_FEED_MAX_RECORDS } from "../feeds/constants.js";

/**
 * Dedup key: marketplace + identifier type/value (case-sensitive) + warehouse (or "").
 * Uses a JSON tuple so values containing the separator can never collide.
 */
function dedupKey(marketplace: NeweggMarketplace, update: NormalizedInventoryUpdate): string {
  const id = update.identifier;
  return JSON.stringify([marketplace, id.type, id.value, update.warehouseLocation ?? ""]);
}

interface DedupResult {
  deduped: NormalizedInventoryUpdate[];
  report: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }>;
  deduplicatedItemCount: number;
}

/** Last-write-wins dedup, preserving first-seen ordering for stable feed chunking. */
export function dedupeUpdates(
  marketplace: NeweggMarketplace,
  updates: NormalizedInventoryUpdate[],
): DedupResult {
  const byKey = new Map<string, { kept: NormalizedInventoryUpdate; dropped: number[] }>();
  const order: string[] = [];
  for (const update of updates) {
    const key = dedupKey(marketplace, update);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { kept: update, dropped: [] });
      order.push(key);
    } else {
      existing.dropped.push(existing.kept.inputIndex);
      existing.kept = update;
    }
  }
  const deduped: NormalizedInventoryUpdate[] = [];
  const report: Array<{ keptInputIndex: number; droppedInputIndexes: number[] }> = [];
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

function feedChunkCount(itemCount: number): number {
  return itemCount === 0 ? 0 : Math.ceil(itemCount / INVENTORY_FEED_MAX_RECORDS);
}

function isSellerPartNumber(update: NormalizedInventoryUpdate): boolean {
  return update.identifier.type === "sellerPartNumber";
}

interface StrategyDecision {
  resolved: "direct" | "feed" | "mixed";
  direct: NormalizedInventoryUpdate[];
  feed: NormalizedInventoryUpdate[];
  plannedFeedCount: number;
  warnings: string[];
}

/**
 * Decides how a deduped update set is executed. `auto` uses direct updates at or below the
 * feed threshold, otherwise routes sellerPartNumber items to feeds and everything else to
 * direct (reported as "mixed"). Explicit `feed` with non-SPN items throws.
 */
export function decideStrategy(
  deduped: NormalizedInventoryUpdate[],
  options: { strategy: InventoryUpdateStrategy; autoFeedThreshold: number },
): StrategyDecision {
  if (options.strategy === "direct") {
    return { resolved: "direct", direct: deduped, feed: [], plannedFeedCount: 0, warnings: [] };
  }

  if (options.strategy === "feed") {
    const nonSpn = deduped.filter((update) => !isSellerPartNumber(update));
    if (nonSpn.length > 0) {
      const issues: NeweggValidationIssue[] = nonSpn.map((update) => ({
        path: "identifier.type",
        message: "strategy 'feed' requires a sellerPartNumber identifier",
        inputIndex: update.inputIndex,
      }));
      throw new NeweggValidationError(
        "Feed strategy requires sellerPartNumber identifiers.",
        issues,
      );
    }
    return {
      resolved: "feed",
      direct: [],
      feed: deduped,
      plannedFeedCount: feedChunkCount(deduped.length),
      warnings: [],
    };
  }

  // auto
  if (deduped.length <= options.autoFeedThreshold) {
    return { resolved: "direct", direct: deduped, feed: [], plannedFeedCount: 0, warnings: [] };
  }
  const feed = deduped.filter(isSellerPartNumber);
  const direct = deduped.filter((update) => !isSellerPartNumber(update));
  const warnings: string[] = [];
  if (feed.length > 0 && direct.length > 0) {
    warnings.push(
      `${direct.length} item(s) without a sellerPartNumber will be updated directly instead of via feed`,
    );
  }
  let resolved: "direct" | "feed" | "mixed";
  if (feed.length > 0 && direct.length > 0) resolved = "mixed";
  else if (feed.length > 0) resolved = "feed";
  else resolved = "direct";
  return { resolved, direct, feed, plannedFeedCount: feedChunkCount(feed.length), warnings };
}

/** Warnings for B2B/CAN updates that specify a warehouse (ignored — default-warehouse semantics). */
export function warehouseIgnoredWarnings(
  marketplace: NeweggMarketplace,
  updates: NormalizedInventoryUpdate[],
): string[] {
  if (marketplace === "us") return [];
  const warnings: string[] = [];
  for (const update of updates) {
    if (update.warehouseLocation !== undefined) {
      const label =
        update.identifier.type === "sellerPartNumber"
          ? update.identifier.value
          : `input ${update.inputIndex}`;
      warnings.push(
        `Item ${label}: warehouseLocation ignored (default-warehouse semantics on ${marketplace}).`,
      );
    }
  }
  return warnings;
}

export function countZeroQuantity(updates: NormalizedInventoryUpdate[]): number {
  return updates.filter((update) => update.quantity === 0).length;
}
