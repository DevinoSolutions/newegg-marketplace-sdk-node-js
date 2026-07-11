import type { ItemCondition } from "../types.js";

/**
 * Item-condition code mapping. Documented ASSUMPTION (see `newegg-api-contracts.md` §4):
 * the condition table did not render in extraction; this matches the codes used across
 * Newegg's Item Management APIs. Isolated here so a doc correction is a one-file change.
 */
export const CONDITION_TO_CODE: Record<ItemCondition, number> = {
  new: 1,
  refurbished: 2,
  usedLikeNew: 3,
  usedVeryGood: 4,
  usedGood: 5,
  usedAcceptable: 6,
};

const CODE_TO_CONDITION: Record<number, ItemCondition> = {
  1: "new",
  2: "refurbished",
  3: "usedLikeNew",
  4: "usedVeryGood",
  5: "usedGood",
  6: "usedAcceptable",
};

/** All valid condition names, in code order. */
export const ITEM_CONDITIONS: ItemCondition[] = Object.keys(CONDITION_TO_CODE) as ItemCondition[];

export function conditionToCode(condition: ItemCondition): number {
  return CONDITION_TO_CODE[condition];
}

export function codeToCondition(
  code: number | string | undefined | null,
): ItemCondition | undefined {
  if (code === undefined || code === null) return undefined;
  const n = typeof code === "string" ? Number(code.trim()) : code;
  if (!Number.isFinite(n)) return undefined;
  return CODE_TO_CONDITION[n];
}
