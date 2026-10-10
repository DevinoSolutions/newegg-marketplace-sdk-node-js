/**
 * RMA read constants and wire-code mappings (see `newegg-api-contracts.md` §18.1). Newegg
 * encodes RMA status, type, reason and filters as small integers; these pure helpers convert
 * between those codes and the SDK's normalized string unions.
 */
import type {
  ListRmasInput,
  RmaKeywordType,
  RmaProcessedBy,
  RmaReason,
  RmaStatus,
  RmaType,
} from "../types.js";

/** Fixed `OperationType` of Get RMA Information. */
export const RMA_INFO_OPERATION_TYPE = "GetRMAInfoRequest";

/** Path (after the platform prefix) of Get RMA Information. */
export const RMA_INFO_PATH = "servicemgmt/rma/rmainfo";

/** `RMAStatus` / `Status` wire code (1-6) -> normalized union. */
export function rmaStatusFromCode(code: number | undefined): RmaStatus {
  switch (code) {
    case 1:
      return "open";
    case 2:
      return "received";
    case 3:
      return "rejected";
    case 4:
      return "voided";
    case 5:
      return "closed";
    case 6:
      return "processing";
    default:
      return "unknown";
  }
}

/** Normalized status filter -> wire `Status` code (0 = all is simply omitted). */
export function rmaStatusToCode(status: Exclude<RmaStatus, "unknown">): number {
  switch (status) {
    case "open":
      return 1;
    case "received":
      return 2;
    case "rejected":
      return 3;
    case "voided":
      return 4;
    case "closed":
      return 5;
    case "processing":
      return 6;
  }
}

/** `RMAType` wire code (1 replacement / 2 refund) -> normalized union. */
export function rmaTypeFromCode(code: number | undefined): RmaType {
  switch (code) {
    case 1:
      return "replacement";
    case 2:
      return "refund";
    default:
      return "unknown";
  }
}

/** Normalized type filter -> wire `RMAType` code. */
export function rmaTypeToCode(type: NonNullable<ListRmasInput["type"]>): number {
  return type === "replacement" ? 1 : 2;
}

/** `ProcessedBy` filter -> wire code (1 seller / 2 Newegg). */
export function rmaProcessedByToCode(by: RmaProcessedBy): number {
  return by === "seller" ? 1 : 2;
}

/** `RMAProcessedBy` response label ("Newegg" / "Seller") -> normalized union. */
export function rmaProcessedByFromLabel(label: string | undefined): RmaProcessedBy | undefined {
  switch (label?.trim().toLowerCase()) {
    case "seller":
      return "seller";
    case "newegg":
      return "newegg";
    default:
      return undefined;
  }
}

/** `KeywordsType` filter -> wire code. */
export function rmaKeywordTypeToCode(type: RmaKeywordType): number {
  switch (type) {
    case "rmaNumber":
      return 1;
    case "orderNumber":
      return 2;
    case "customerName":
      return 3;
    case "sellerRmaNumber":
      return 4;
  }
}

/** `RMAReason` wire code (1-9) -> normalized union. */
export function rmaReasonFromCode(code: number | undefined): RmaReason {
  switch (code) {
    case 1:
      return "itemDamaged";
    case 2:
      return "defective";
    case 3:
      return "incompatible";
    case 4:
      return "noLongerNeeded";
    case 5:
      return "notAsDescribed";
    case 6:
      return "orderedWrongItem";
    case 7:
      return "sentWrongItem";
    case 8:
      return "unsatisfied";
    case 9:
      return "other";
    default:
      return "unknown";
  }
}

/** `ShippedBy` wire code (0 SBS / 1 SBN) -> normalized union. */
export function rmaShippedByFromCode(code: number | undefined): "seller" | "newegg" | undefined {
  switch (code) {
    case 0:
      return "seller";
    case 1:
      return "newegg";
    default:
      return undefined;
  }
}
