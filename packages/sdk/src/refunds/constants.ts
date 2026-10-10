/**
 * Courtesy-refund read constants and wire-code mappings (see `newegg-api-contracts.md` §18.2 /
 * §18.3). Pure helpers converting between Newegg's codes/labels and the SDK's normalized unions.
 */
import type {
  CourtesyRefundKeywordType,
  CourtesyRefundReason,
  CourtesyRefundRequestState,
  CourtesyRefundStatus,
} from "../types.js";

/** Fixed `OperationType` of Get Courtesy Refund Information. */
export const COURTESY_REFUND_INFO_OPERATION_TYPE = "GetCourtesyRefundInfo";
/** Fixed `OperationType` of Get Courtesy Refund Request Status. */
export const COURTESY_REFUND_STATUS_OPERATION_TYPE = "GetCourtesyRefundStatusRequest";

/** Paths (after the platform prefix). */
export const COURTESY_REFUND_INFO_PATH = "servicemgmt/courtesyrefund/info";
export const COURTESY_REFUND_STATUS_PATH = "servicemgmt/courtesyrefund/requeststatus";

/** Maximum records Get Courtesy Refund Request Status returns (`MaxCount`). */
export const COURTESY_REFUND_STATUS_MAX_COUNT = 100;

/** `KeywordsType` filter -> wire code (0 = all is simply omitted). */
export function courtesyKeywordTypeToCode(type: CourtesyRefundKeywordType): number {
  switch (type) {
    case "courtesyRefundId":
      return 1;
    case "orderNumber":
      return 2;
    case "customerName":
      return 3;
  }
}

/**
 * Request-side `Status` filter code. The REQUEST table documents 1 Open / 2 Void / 3 Close, which
 * contradicts the response table's 1 Open / 2 Close / 3 Void (contracts §18.2 ASSUMPTION: each
 * table is right for its own direction).
 */
export function courtesyStatusToFilterCode(
  status: Exclude<CourtesyRefundStatus, "unknown">,
): number {
  switch (status) {
    case "open":
      return 1;
    case "void":
      return 2;
    case "closed":
      return 3;
  }
}

/**
 * Response `Status`: every sample sends the label (`"Close"`), the field table lists digits
 * (1 Open / 2 Close / 3 Void). Both are accepted.
 */
export function courtesyStatusFromWire(value: string | undefined): CourtesyRefundStatus {
  switch (value?.trim().toLowerCase()) {
    case "1":
    case "open":
      return "open";
    case "2":
    case "close":
    case "closed":
      return "closed";
    case "3":
    case "void":
    case "voided":
      return "void";
    default:
      return "unknown";
  }
}

/** `ReasonCode` (1-6) -> normalized union. */
export function courtesyReasonFromCode(code: number | undefined): CourtesyRefundReason {
  switch (code) {
    case 1:
      return "negativeCustomerFeedback";
    case 2:
      return "pricingError";
    case 3:
      return "wrongItemInformation";
    case 4:
      return "shippingDelay";
    case 5:
      return "packageNotReceived";
    case 6:
      return "customerCourtesy";
    default:
      return "unknown";
  }
}

/** Request-status `RequestStatus` filter -> wire label. */
export function courtesyRequestStateToWire(
  state: Exclude<CourtesyRefundRequestState, "unknown">,
): string {
  switch (state) {
    case "submitted":
      return "SUBMITTED";
    case "inProgress":
      return "IN_PROGRESS";
    case "finished":
      return "FINISHED";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
  }
}

/** Response `RequestStatus` label -> normalized state (tolerant of case and `CANCELED`). */
export function courtesyRequestStateFromWire(
  value: string | undefined,
): CourtesyRefundRequestState {
  switch (value?.trim().toUpperCase().replace(/[\s-]/g, "_")) {
    case "SUBMITTED":
      return "submitted";
    case "IN_PROGRESS":
    case "INPROGRESS":
      return "inProgress";
    case "FINISHED":
      return "finished";
    case "FAILED":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    default:
      return "unknown";
  }
}
