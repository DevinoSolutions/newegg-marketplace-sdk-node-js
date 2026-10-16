/**
 * RMA and courtesy-refund WRITE constants and wire-code mappings (see `newegg-api-contracts.md`
 * §20). Pure helpers; the per-marketplace differences live in `platform/rma.ts`.
 */
import type { CourtesyRefundReason, RmaRejectCarrier, RmaWriteReason } from "../types.js";

/** Paths (after the platform prefix). Edit, Process (receive) and Reject share `updaterma`. */
export const RMA_SUBMIT_PATH = "servicemgmt/rma/newrma";
export const RMA_UPDATE_PATH = "servicemgmt/rma/updaterma";
export const COURTESY_REFUND_ISSUE_PATH = "servicemgmt/courtesyrefund/new";

/** Fixed `OperationType` of each write. */
export const RMA_SUBMIT_OPERATION_TYPE = "IssueRMARequest";
export const RMA_EDIT_OPERATION_TYPE = "EditRMARequest";
export const RMA_RECEIVE_OPERATION_TYPE = "ReceiveRMARequest";
export const RMA_REJECT_OPERATION_TYPE = "RejectRMARequest";
export const COURTESY_REFUND_ISSUE_OPERATION_TYPE = "IssueCourtesyRefund";

/** Largest money amount the SDK accepts (the same 2-decimal ceiling the price writes use). */
export const SERVICE_WRITE_MAX_AMOUNT = 99999.99;

/** Most lines a single RMA write carries. */
export const RMA_WRITE_MAX_ITEMS = 50;

/** Request-side `RMAReason` (1-10) for each {@link RmaWriteReason}. */
export const RMA_WRITE_REASON_CODES: Readonly<Record<RmaWriteReason, number>> = {
  itemDamaged: 1,
  defective: 2,
  notAsDescribed: 5,
  sentWrongItem: 7,
  extraItemShipped: 9,
  itemNotReceived: 10,
  incompatible: 3,
  noLongerNeeded: 4,
  orderedWrongItem: 6,
  unsatisfied: 8,
};

/** Reasons (codes 3, 4, 6, 8) for which `UnOpen`, the evidence images and the memo are required. */
export const RMA_EVIDENCE_REASONS: ReadonlySet<RmaWriteReason> = new Set([
  "incompatible",
  "noLongerNeeded",
  "orderedWrongItem",
  "unsatisfied",
]);

/** Reject RMA `RejectReason` codes whose memo and images are required (4, 6-12). */
export const REJECT_EVIDENCE_CODES: ReadonlySet<number> = new Set([4, 6, 7, 8, 9, 10, 11, 12]);

/** `ShipCarrier` code of each {@link RmaRejectCarrier}. */
export const REJECT_CARRIER_CODES: Readonly<Record<RmaRejectCarrier, number>> = {
  ups: 1,
  fedex: 2,
  dhl: 3,
  usps: 4,
  other: 5,
};

/** Request `RefundReason` (1-6) for each courtesy refund reason. */
export function courtesyReasonToCode(reason: Exclude<CourtesyRefundReason, "unknown">): number {
  switch (reason) {
    case "negativeCustomerFeedback":
      return 1;
    case "pricingError":
      return 2;
    case "wrongItemInformation":
      return 3;
    case "shippingDelay":
      return 4;
    case "packageNotReceived":
      return 5;
    case "customerCourtesy":
      return 6;
  }
}

/** Money in whole cents, so sums and comparisons never accumulate floating-point error. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Cents back to a number with two decimals. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Wire form of a money amount: a string with exactly two decimals (`"200.00"`). */
export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}
