/**
 * Pure request builders and tolerant response parsers for the RMA and courtesy-refund WRITES
 * (contracts §20). Free of transport concerns so they can be unit-tested against raw wire
 * fixtures. Request values are STRINGS, exactly as in the documented JSON samples; money is sent
 * with two decimals and never rounded here (the validators reject anything finer).
 */
import type {
  CourtesyRefundRequestState,
  EditRmaInput,
  IssueCourtesyRefundInput,
  ProcessRmaInput,
  RejectRmaInput,
  Rma,
  RmaWriteItem,
  SubmitRmaInput,
} from "../types.js";
import type { RmaPlatform } from "../platform/rma.js";
import { toTimestamp } from "../platform/dates.js";
import { asString, getField } from "../schemas/wire.js";
import { listItems, unwrapResponse } from "../servicemgmt/shared.js";
import { courtesyRequestStateFromWire } from "../refunds/constants.js";
import { parseRma } from "./parse.js";
import {
  COURTESY_REFUND_ISSUE_OPERATION_TYPE,
  REJECT_CARRIER_CODES,
  RMA_EDIT_OPERATION_TYPE,
  RMA_RECEIVE_OPERATION_TYPE,
  RMA_REJECT_OPERATION_TYPE,
  RMA_SUBMIT_OPERATION_TYPE,
  RMA_WRITE_REASON_CODES,
  courtesyReasonToCode,
  formatAmount,
} from "./write-constants.js";

/** One value stays a bare value and several become an array (the usual object-or-array quirk). */
function oneOrMany<T>(values: readonly T[]): T | T[] {
  return values.length === 1 ? (values[0] as T) : [...values];
}

function transactionOf(
  item: RmaWriteItem,
  type: "refund" | "replacement",
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    SellerPartNumber: item.sellerPartNumber,
    ReturnQuantity: String(item.returnQuantity),
  };
  if (type === "refund") {
    if (item.returnUnitPrice !== undefined)
      row.ReturnUnitPrice = formatAmount(item.returnUnitPrice);
    if (item.refundShippingPrice !== undefined) {
      row.RefundShippingPrice = formatAmount(item.refundShippingPrice);
    }
  }
  row.RMAReason = String(RMA_WRITE_REASON_CODES[item.reason]);
  if (item.unopened !== undefined) row.UnOpen = item.unopened ? "1" : "0";
  if (item.imageUrls !== undefined) row.FileUrls = { ImgUrl: [...item.imageUrls] };
  if (item.memo !== undefined) row.Memo = item.memo;
  return row;
}

function transactionList(
  items: readonly RmaWriteItem[],
  type: "refund" | "replacement",
): Record<string, unknown> {
  return { RMATransaction: oneOrMany(items.map((item) => transactionOf(item, type))) };
}

function rmaTypeCode(type: "refund" | "replacement"): string {
  return type === "replacement" ? "1" : "2";
}

/** Submit RMA body (`IssueRMARequest`). */
export function buildSubmitRmaBody(input: SubmitRmaInput): unknown {
  const issue: Record<string, unknown> = {
    RMAType: rmaTypeCode(input.type),
    SourceSONumber: String(input.orderNumber),
  };
  if (input.sellerRmaNumber !== undefined) issue.SellerRMANumber = input.sellerRmaNumber;
  if (input.autoReceive === true) issue.AutoReceiveMark = "1";
  if (input.note !== undefined) issue.RMANote = input.note;
  issue.RMATransactionList = transactionList(input.items, input.type);
  return { OperationType: RMA_SUBMIT_OPERATION_TYPE, RequestBody: { IssueRMA: issue } };
}

/** Edit RMA body (`EditRMARequest`). */
export function buildEditRmaBody(input: EditRmaInput): unknown {
  const edit: Record<string, unknown> = {
    RMANumber: String(input.rmaNumber),
    RMAType: rmaTypeCode(input.type),
  };
  if (input.sellerRmaNumber !== undefined) edit.SellerRMANumber = input.sellerRmaNumber;
  edit.RMANote = input.note;
  edit.RMATransactionList = transactionList(input.items, input.type);
  return { OperationType: RMA_EDIT_OPERATION_TYPE, RequestBody: { EditRMAInfo: edit } };
}

/** Process (receive) RMA body (`ReceiveRMARequest`). */
export function buildReceiveRmaBody(input: ProcessRmaInput): unknown {
  return {
    OperationType: RMA_RECEIVE_OPERATION_TYPE,
    RequestBody: { ReceiveRMAInfo: { RMANumber: String(input.rmaNumber) } },
  };
}

/** Reject RMA body (`RejectRMARequest`); `rejectReasonCode` comes from the marketplace's set. */
export function buildRejectRmaBody(input: RejectRmaInput, rejectReasonCode: number): unknown {
  const reject: Record<string, unknown> = {
    RMANumber: String(input.rmaNumber),
    RejectReason: String(rejectReasonCode),
    ShipCarrier: String(REJECT_CARRIER_CODES[input.carrier]),
  };
  if (input.otherCarrier !== undefined) reject.OtherShipCarrier = input.otherCarrier;
  reject.ShipService = input.shipService;
  reject.TrackingNumberList = { TrackingNumber: oneOrMany(input.trackingNumbers) };
  if (input.memo !== undefined) reject.RejectReasonMemo = input.memo;
  if (input.imageUrls !== undefined) {
    reject.RejectReasonDescriptionImages = { ImageUrl: [...input.imageUrls] };
  }
  return { OperationType: RMA_REJECT_OPERATION_TYPE, RequestBody: { RejectRMAInfo: reject } };
}

/** Issue Courtesy Refund body (`IssueCourtesyRefund`). */
export function buildIssueCourtesyRefundBody(input: IssueCourtesyRefundInput): unknown {
  const issue: Record<string, unknown> = {
    SourceSONumber: String(input.orderNumber),
    RefundReason: String(courtesyReasonToCode(input.reason)),
    TotalRefundAmount: formatAmount(input.amount),
  };
  if (input.noteToCustomer !== undefined) issue.NoteToCustomer = input.noteToCustomer;
  return {
    OperationType: COURTESY_REFUND_ISSUE_OPERATION_TYPE,
    RequestBody: { IssueCourtesyRefund: issue },
  };
}

/** Reject-reason wire code for `input` on `platform` (the validator has already checked it exists). */
export function rejectReasonCode(input: RejectRmaInput, platform: RmaPlatform): number {
  const code = platform.rejectReasonCodes[input.reason];
  if (code === undefined) {
    throw new RangeError(
      `reject reason ${input.reason} is not documented for ${platform.marketplace}`,
    );
  }
  return code;
}

/**
 * Parses an RMA write response. The Edit / Process / Reject samples nest the RMA under
 * `ResponseBody > RMAInfo`; the Submit page lists the same fields flat and its JSON "response" sample
 * is a copy of the request (contracts §20.1), so the RMA is read from `RMAInfo`, else from the body,
 * else from the root. `IsSuccess=false` throws a {@link NeweggApiError} (definitive failure).
 */
export function parseRmaWriteResponse(json: unknown, correlationId: string): Rma {
  const { root, body } = unwrapResponse(json, correlationId);
  const info = getField(body, "RMAInfo");
  const candidates = [info, body, root];
  for (const candidate of candidates) {
    if (candidate !== undefined && asString(getField(candidate, "RMANumber")) !== undefined) {
      return parseRma(candidate);
    }
  }
  return parseRma(info ?? body);
}

/** What Issue Courtesy Refund returns. */
export interface CourtesyRefundIssueResponse {
  requestId?: string;
  requestDate?: { raw: string; iso?: string };
  state: CourtesyRefundRequestState;
  stateRaw?: string;
  memo?: string;
}

/**
 * Parses an Issue Courtesy Refund response: `ResponseBody > ResponseList > ResponseInfo
 * { RequestId, RequestDate, RequestStatus }` in the JSON sample; the field table spells the keys
 * `RequestID` / `RequestSatus` and lists a flat `Memo`, so every spelling and placement is read.
 */
export function parseCourtesyRefundIssueResponse(
  json: unknown,
  correlationId: string,
): CourtesyRefundIssueResponse {
  const { root, body } = unwrapResponse(json, correlationId);
  const info = listItems(getField(body, "ResponseList"), "ResponseInfo")[0] ?? body;
  const g = (key: string): unknown => getField(info, key) ?? getField(body, key);
  const stateRaw = asString(g("RequestStatus")) ?? asString(g("RequestSatus"));
  return {
    requestId: asString(g("RequestId")) ?? asString(g("RequestID")),
    requestDate: toTimestamp(asString(g("RequestDate"))),
    state: courtesyRequestStateFromWire(stateRaw),
    stateRaw,
    memo: asString(g("Memo")) ?? asString(getField(root, "Memo")),
  };
}
