/**
 * Request builders + tolerant response parsers for the Settlement Summary and Settlement
 * Transaction reports (contracts §17.2 / §17.3), plus the row mapping for the tab/comma
 * delimited Daily Inventory / Daily Price files (§17.4 / §17.5).
 *
 * Newegg quirks handled here: amounts arrive as strings (possibly with thousands separators),
 * the response may or may not be wrapped in `NeweggAPIResponse`, lists are object-OR-array and
 * (XML-era) wrapped in a one-key child node, `PageInfo` sits in `ResponseBody` (or the root),
 * `SellerID`/`sellerID` and `RequestId`/`RequestID` vary in case, and the documented JSON sample
 * misspells `SalesTaxFeeCollectedFromCustomer` as `SalerTax…`.
 */
import type {
  DailyInventoryRow,
  DailyPriceRow,
  ItemBasicInfoRow,
  ItemVarietyOption,
  Order,
  Rma,
  SettlementSummaryAmountField,
  SettlementSummaryRow,
  SettlementTransactionRow,
} from "../types.js";
import { parseOrder } from "../orders/parse.js";
import { toTimestamp } from "../platform/dates.js";
import { parseRma } from "../rma/parse.js";
import { REPORT_RESULT_PAGE_SIZE } from "../reportmgmt/constants.js";
import { normalizeHeader } from "../reportmgmt/csv.js";
import { unwrapEnvelope } from "../reportmgmt/lifecycle.js";
import { asArray, asBoolean, asNumber, asString, getField, isRecord } from "../schemas/wire.js";
import {
  SETTLEMENT_SUMMARY_OPERATION_TYPE,
  SETTLEMENT_SUMMARY_REQUEST_TYPE,
  SETTLEMENT_TRANSACTION_OPERATION_TYPE,
  SETTLEMENT_TRANSACTION_REQUEST_TYPE,
} from "./constants.js";
import type { NormalizedTransactionsCriteria } from "./validate.js";

// ---------------------------------------------------------------------------
// request builders
// ---------------------------------------------------------------------------
export function buildSettlementSummarySubmit(range: {
  dateFrom: string;
  dateTo: string;
}): Record<string, unknown> {
  return {
    OperationType: SETTLEMENT_SUMMARY_OPERATION_TYPE,
    RequestBody: {
      SettlementSummaryReportCriteria: {
        RequestType: SETTLEMENT_SUMMARY_REQUEST_TYPE,
        DateFrom: range.dateFrom,
        DateTo: range.dateTo,
      },
    },
  };
}

export function buildSettlementTransactionsSubmit(
  criteria: NormalizedTransactionsCriteria,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    RequestType: SETTLEMENT_TRANSACTION_REQUEST_TYPE,
    TransactionType: String(criteria.transactionTypeCode),
  };
  if (criteria.orderNumber !== undefined) body.OrderNumber = criteria.orderNumber;
  if (criteria.settlementId !== undefined) body.SettlementID = criteria.settlementId;
  if (criteria.settlementDate !== undefined) body.SettlementDate = criteria.settlementDate;
  if (criteria.settlementDateFrom !== undefined) {
    body.SettlementDateFrom = criteria.settlementDateFrom;
  }
  if (criteria.settlementDateTo !== undefined) body.SettlementDateTo = criteria.settlementDateTo;
  return {
    OperationType: SETTLEMENT_TRANSACTION_OPERATION_TYPE,
    RequestBody: { SettlementTransactionReportCriteria: body },
  };
}

/** Paged result request (§17.2 / §17.3). The OperationType is the report's REQUEST type. */
export function buildPagedResultRequest(
  operationType: string,
  requestId: string,
  pageIndex: number,
): Record<string, unknown> {
  return {
    OperationType: operationType,
    RequestBody: {
      RequestID: requestId,
      PageInfo: { PageIndex: pageIndex, PageSize: REPORT_RESULT_PAGE_SIZE },
    },
  };
}

/** File-report result request (§17.4 / §17.5): just the request id, no paging. */
export function buildFileResultRequest(
  operationType: string,
  requestId: string,
): Record<string, unknown> {
  return { OperationType: operationType, RequestBody: { RequestID: requestId } };
}

// ---------------------------------------------------------------------------
// scalar readers
// ---------------------------------------------------------------------------
/** Money reader: `"102.95"`, `"-1.98"`, `"1,234.50"`, `"(12.00)"` and `"$5"` all parse. */
export function asAmount(value: unknown): number | undefined {
  const direct = asNumber(value);
  if (direct !== undefined) return direct;
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  if (text === "" || text.toLowerCase() === "null") return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[$,\s]/g, "");
  if (text === "") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n)) return undefined;
  return negative ? -n : n;
}

/** First scalar of a possibly-array/empty field (`CheckNumber: []` -> undefined). */
function firstScalar(value: unknown): string | undefined {
  for (const entry of asArray(value)) {
    const text = asString(entry);
    if (text !== undefined && text !== "" && text.toLowerCase() !== "null") return text;
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  const text = asString(value);
  return text === undefined || text === "" || text.toLowerCase() === "null" ? undefined : text;
}

/** Case-insensitive field read - Newegg's key casing drifts (`SellerID`/`sellerID`). */
function ciField(record: unknown, key: string): unknown {
  if (!isRecord(record)) return undefined;
  if (key in record) return record[key];
  const lower = key.toLowerCase();
  for (const [candidate, value] of Object.entries(record)) {
    if (candidate.toLowerCase() === lower) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// page envelope
// ---------------------------------------------------------------------------
interface PageEnvelope {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPageCount: number;
  requestDate?: { raw: string; iso?: string };
  /** The list node, before row extraction. */
  list: unknown;
}

/** Rows of a list node: array, single object, or an XML-era `{ ChildName: [...] }` wrapper. */
function listRows(list: unknown, childKey: string): Array<Record<string, unknown>> {
  const inner = getField(list, childKey);
  // A blank string / empty node is an empty list, never a phantom row (seen live, 2026-10-10).
  return asArray(inner !== undefined ? inner : list)
    .filter(isRecord)
    .filter((row) => Object.keys(row).length > 0);
}

function readEnvelope(json: unknown, listKey: string): PageEnvelope {
  const root = unwrapEnvelope(json);
  const body = getField(root, "ResponseBody");
  const pageInfo = isRecord(getField(body, "PageInfo"))
    ? getField(body, "PageInfo")
    : getField(root, "PageInfo");
  const list = getField(body, listKey) ?? getField(root, listKey);
  return {
    page: asNumber(getField(pageInfo, "PageIndex")) ?? 1,
    pageSize: asNumber(getField(pageInfo, "PageSize")) ?? REPORT_RESULT_PAGE_SIZE,
    totalCount: asNumber(getField(pageInfo, "TotalCount")) ?? 0,
    totalPageCount: asNumber(getField(pageInfo, "TotalPageCount")) ?? 1,
    requestDate: toTimestamp(asString(getField(body, "RequestDate"))),
    list,
  };
}

// ---------------------------------------------------------------------------
// settlement summary
// ---------------------------------------------------------------------------
const SUMMARY_AMOUNT_KEYS: Record<string, SettlementSummaryAmountField> = {
  itemprice: "itemPrice",
  shipping: "shipping",
  taxduty: "taxDuty",
  gsttotal: "gstTotal",
  hsttotal: "hstTotal",
  gstandhst: "gstAndHst",
  psttotal: "pstTotal",
  pstandqst: "pstAndQst",
  ehftotal: "ehfTotal",
  other: "other",
  recyclingfeetotal: "recyclingFeeTotal",
  totalorderamount: "totalOrderAmount",
  refunds: "refunds",
  chargeback: "chargeBack",
  miscellaneousadjustment: "miscellaneousAdjustment",
  courtesyrefund: "courtesyRefund",
  totalrefunds: "totalRefunds",
  neweggcommissionfee: "neweggCommissionFee",
  neweggtransactionfee: "neweggTransactionFee",
  neweggrefundcommissionfee: "neweggRefundCommissionFee",
  neweggmonthlyfee: "neweggMonthlyFee",
  neweggstoragefee: "neweggStorageFee",
  neweggrmabuyoutfee: "neweggRmaBuyoutFee",
  neweggservicefeetax: "neweggServiceFeeTax",
  neweggpremierfee: "neweggPremierFee",
  neweggshippinglabelfee: "neweggShippingLabelFee",
  creditcardpayment: "creditCardPayment",
  fulfillmentbyneweggfee: "fulfillmentByNeweggFee",
  multichannelfee: "multiChannelFee",
  adjustmentfee: "adjustmentFee",
  merchandisingfee: "merchandisingFee",
  totalneweggfee: "totalNeweggFee",
  totalsettlement: "totalSettlement",
  salestaxfeecollectedfromcustomer: "salesTaxFeeCollectedFromCustomer",
  // The official JSON sample misspells the key (contracts §17.2).
  salertaxfeecollectedfromcustomer: "salesTaxFeeCollectedFromCustomer",
  salestaxfeesliabilityshifttonewegg: "salesTaxFeesLiabilityShiftToNewegg",
  reservedbalance: "reservedBalance",
  previousreservedbalance: "previousReservedBalance",
};

const SUMMARY_HANDLED = new Set([
  "settlementdate",
  "settlementdatefrom",
  "settlementdateto",
  "settlementid",
  "checknumber",
  "memo",
]);

function summaryRow(row: Record<string, unknown>): SettlementSummaryRow {
  const out: SettlementSummaryRow = {};
  const unmapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const lower = key.toLowerCase();
    const amountField = SUMMARY_AMOUNT_KEYS[lower];
    if (amountField !== undefined) {
      const amount = asAmount(value);
      if (amount !== undefined) out[amountField] = amount;
    } else if (!SUMMARY_HANDLED.has(lower)) {
      const scalar = nonEmpty(value);
      if (scalar !== undefined) unmapped[key] = scalar;
    }
  }
  const settlementDate = toTimestamp(nonEmpty(ciField(row, "SettlementDate")));
  if (settlementDate) out.settlementDate = settlementDate;
  const from = toTimestamp(nonEmpty(ciField(row, "SettlementDateFrom")));
  if (from) out.settlementDateFrom = from;
  const to = toTimestamp(nonEmpty(ciField(row, "SettlementDateTo")));
  if (to) out.settlementDateTo = to;
  const settlementId = nonEmpty(ciField(row, "SettlementID"));
  if (settlementId !== undefined) out.settlementId = settlementId;
  const checkNumber = firstScalar(ciField(row, "CheckNumber"));
  if (checkNumber !== undefined) out.checkNumber = checkNumber;
  const memo = nonEmpty(ciField(row, "Memo"));
  if (memo !== undefined) out.memo = memo;
  if (Object.keys(unmapped).length > 0) out.unmapped = unmapped;
  return out;
}

export interface ParsedPage<Row> extends Omit<PageEnvelope, "list"> {
  rows: Row[];
}

export function parseSettlementSummaryPage(json: unknown): ParsedPage<SettlementSummaryRow> {
  const envelope = readEnvelope(json, "SettlementSummaryList");
  const rows = listRows(envelope.list, "SettlementSummaryInfo").map((row) => summaryRow(row));
  const { list: _list, ...rest } = envelope;
  return { ...rest, totalCount: envelope.totalCount || rows.length, rows };
}

// ---------------------------------------------------------------------------
// settlement transactions
// ---------------------------------------------------------------------------
function transactionRow(row: Record<string, unknown>): SettlementTransactionRow {
  const out: SettlementTransactionRow = {};
  const transactionDate = toTimestamp(nonEmpty(ciField(row, "TransactionDate")));
  if (transactionDate) out.transactionDate = transactionDate;
  const strings: Array<[keyof SettlementTransactionRow, string]> = [
    ["transactionType", "TransactionType"],
    ["orderNumber", "OrderID"],
    ["invoiceNumber", "InvoiceID"],
    ["sellerPartNumber", "SellerPartNumber"],
    ["neweggItemNumber", "NeweggItemNumber"],
    ["itemDescription", "ItemDescription"],
    ["itemCondition", "ItemCondition"],
    ["settlementId", "SettlementID"],
    ["memo", "Memo"],
  ];
  for (const [field, key] of strings) {
    const value = nonEmpty(ciField(row, key));
    if (value !== undefined) (out as Record<string, unknown>)[field] = value;
  }
  const amount = asAmount(ciField(row, "Amount"));
  if (amount !== undefined) out.amount = amount;
  const shipping = asAmount(ciField(row, "Shipping"));
  if (shipping !== undefined) out.shipping = shipping;
  const commissionFee = asAmount(ciField(row, "CommissionFee"));
  if (commissionFee !== undefined) out.commissionFee = commissionFee;
  return out;
}

export function parseSettlementTransactionsPage(
  json: unknown,
): ParsedPage<SettlementTransactionRow> {
  const envelope = readEnvelope(json, "SettlementTransactionInfoList");
  const rows = listRows(envelope.list, "SettlementTransactionInfo").map((row) =>
    transactionRow(row),
  );
  const { list: _list, ...rest } = envelope;
  return { ...rest, totalCount: envelope.totalCount || rows.length, rows };
}

// ---------------------------------------------------------------------------
// order list / RMA list (paged inline; rows reuse the Get Order / Get RMA mappers)
// ---------------------------------------------------------------------------
/** Order List result page (§17.6): `OrderInfoList > OrderInfo`, parsed like Get Order Information. */
export function parseOrderListPage(json: unknown): ParsedPage<Order> {
  const envelope = readEnvelope(json, "OrderInfoList");
  const rows = listRows(envelope.list, "OrderInfo").map((row) => parseOrder(row));
  const { list: _list, ...rest } = envelope;
  return { ...rest, totalCount: envelope.totalCount || rows.length, rows };
}

/**
 * The RMA List report nests each line's refund fields under `RMATransaction.RefundInfo` and names
 * them differently from Get RMA Information (live-verified CAN, 2026-10-10). Flatten them onto
 * the names `parseRma` reads, never overriding a field the line already carries.
 */
const RMA_LINE_ALIASES: Array<[from: string, to: string]> = [
  ["ItemReturnQty", "ReturnQuantity"],
  ["ItemRefundPerQty", "ReturnUnitPrice"],
  ["ItemShippingRefund", "RefundShippingPrice"],
  ["RefundReason", "RMAReason"],
  ["RefundReasonDescription", "RMAReasonDescription"],
  ["ReplacementReason", "RMAReason"],
  ["ReplacementReasonDescription", "RMAReasonDescription"],
  // The field table spells it "Replacment" (sic).
  ["ReplacmentReasonDescription", "RMAReasonDescription"],
];

function flattenRmaLine(line: Record<string, unknown>): Record<string, unknown> {
  const info = getField(line, "RefundInfo");
  const out: Record<string, unknown> = { ...(isRecord(info) ? info : {}), ...line };
  for (const [from, to] of RMA_LINE_ALIASES) {
    if (out[to] === undefined && out[from] !== undefined) out[to] = out[from];
  }
  return out;
}

/** RMA List result page (§17.6): `RMAInfoList > RMAInfo`, parsed like Get RMA Information. */
export function parseRmaListPage(json: unknown): ParsedPage<Rma> {
  const envelope = readEnvelope(json, "RMAInfoList");
  const rows = listRows(envelope.list, "RMAInfo").map((row) =>
    parseRma({
      ...row,
      RMATransactionList: listRows(row.RMATransactionList, "RMATransaction").map(flattenRmaLine),
    }),
  );
  const { list: _list, ...rest } = envelope;
  return { ...rest, totalCount: envelope.totalCount || rows.length, rows };
}

// ---------------------------------------------------------------------------
// daily inventory / daily price files
// ---------------------------------------------------------------------------
type RecordOfStrings = Record<string, string>;

/** Header-keyed records from delimited rows (first row = header). Short rows are padded. */
export function recordsFromRows(rows: string[][]): RecordOfStrings[] {
  const header = rows[0];
  if (header === undefined) return [];
  const keys = header.map(normalizeHeader);
  return rows.slice(1).map((cells) => {
    const record: RecordOfStrings = {};
    keys.forEach((key, index) => {
      const cell = cells[index];
      if (key !== "" && cell !== undefined && cell !== "") record[key] = cell;
    });
    return record;
  });
}

function numberCell(record: RecordOfStrings, key: string): number | undefined {
  return asAmount(record[key]);
}

function boolCell(record: RecordOfStrings, key: string): boolean | undefined {
  return asBoolean(record[key]);
}

const KNOWN_INVENTORY_KEYS = new Set([
  "sellerpartnumber",
  "neitemnumber",
  "warehouselocation",
  "fulfillmentoption",
  "inventory",
  "currency",
  "msrp",
  "map",
  "checkoutmap",
  "sellingprice",
  "shipping",
  "activationmark",
  "memo",
]);

const KNOWN_PRICE_KEYS = new Set([
  "sellerpartnumber",
  "neitemnumber",
  "countrycode",
  "currency",
  "msrp",
  "map",
  "checkoutmap",
  "sellingprice",
  "shipping",
  "activationmark",
  "memo",
]);

function extras(record: RecordOfStrings, known: Set<string>): RecordOfStrings | undefined {
  const out: RecordOfStrings = {};
  for (const [key, value] of Object.entries(record)) if (!known.has(key)) out[key] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function inventoryRowFromRecord(record: RecordOfStrings): DailyInventoryRow {
  const row: DailyInventoryRow = {};
  const sellerPartNumber = record.sellerpartnumber;
  if (sellerPartNumber !== undefined) row.sellerPartNumber = sellerPartNumber;
  const neweggItemNumber = record.neitemnumber;
  if (neweggItemNumber !== undefined) row.neweggItemNumber = neweggItemNumber;
  if (record.warehouselocation !== undefined) row.warehouseLocation = record.warehouselocation;
  if (record.fulfillmentoption !== undefined) row.fulfillmentOption = record.fulfillmentoption;
  const inventory = numberCell(record, "inventory");
  if (inventory !== undefined) row.inventory = inventory;
  if (record.currency !== undefined) row.currency = record.currency;
  const msrp = numberCell(record, "msrp");
  if (msrp !== undefined) row.msrp = msrp;
  const map = numberCell(record, "map");
  if (map !== undefined) row.map = map;
  const checkoutMap = boolCell(record, "checkoutmap");
  if (checkoutMap !== undefined) row.checkoutMap = checkoutMap;
  const sellingPrice = numberCell(record, "sellingprice");
  if (sellingPrice !== undefined) row.sellingPrice = sellingPrice;
  if (record.shipping !== undefined) row.shipping = record.shipping;
  const activationMark = boolCell(record, "activationmark");
  if (activationMark !== undefined) row.activationMark = activationMark;
  if (record.memo !== undefined) row.memo = record.memo;
  const extra = extras(record, KNOWN_INVENTORY_KEYS);
  if (extra) row.extra = extra;
  return row;
}

/** Header keys (normalized) of the Item Basic Information report that map to typed fields. */
const KNOWN_ITEM_BASIC_INFO_KEYS = new Set([
  "sellerpartnumber",
  "neitemnumber",
  "manufacturerpartnumber",
  "upc",
  "status",
  // Newegg's header is misspelled "Wesite Short Title"; the corrected spelling is accepted too.
  "wesiteshorttitle",
  "websiteshorttitle",
  "industry",
  "subcategory",
  "bulletdescription",
  "itemlength",
  "itemwidth",
  "itemheight",
  "itemweight",
  "itemimage",
  "datecreated",
  "platform",
  "itemgroupid",
  "customvariety1name",
  "customvariety1value",
  "customvariety2name",
  "customvariety2value",
  "customvariety3name",
  "customvariety3value",
]);

/** `MM/DD/YYYY` (as the file gives it) -> `YYYY-MM-DD`; anything else is returned unchanged. */
function calendarDate(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return value;
  const month = String(match[1]).padStart(2, "0");
  const day = String(match[2]).padStart(2, "0");
  return `${match[3]}-${month}-${day}`;
}

export function itemBasicInfoRowFromRecord(record: RecordOfStrings): ItemBasicInfoRow {
  const row: ItemBasicInfoRow = {};
  if (record.sellerpartnumber !== undefined) row.sellerPartNumber = record.sellerpartnumber;
  if (record.neitemnumber !== undefined) row.neweggItemNumber = record.neitemnumber;
  if (record.manufacturerpartnumber !== undefined) {
    row.manufacturerPartNumber = record.manufacturerpartnumber;
  }
  if (record.upc !== undefined) row.upc = record.upc;
  if (record.status !== undefined) {
    row.status = record.status;
    const lower = record.status.trim().toLowerCase();
    if (lower === "active") row.active = true;
    else if (lower === "inactive") row.active = false;
  }
  const title = record.wesiteshorttitle ?? record.websiteshorttitle;
  if (title !== undefined) row.title = title;
  if (record.industry !== undefined) row.industry = record.industry;
  if (record.subcategory !== undefined) row.subcategory = record.subcategory;
  if (record.bulletdescription !== undefined) row.bulletDescription = record.bulletdescription;
  const length = numberCell(record, "itemlength");
  if (length !== undefined) row.itemLength = length;
  const width = numberCell(record, "itemwidth");
  if (width !== undefined) row.itemWidth = width;
  const height = numberCell(record, "itemheight");
  if (height !== undefined) row.itemHeight = height;
  const weight = numberCell(record, "itemweight");
  if (weight !== undefined) row.itemWeight = weight;
  if (record.itemimage !== undefined) {
    const urls = record.itemimage
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url !== "");
    if (urls.length > 0) row.imageUrls = urls;
  }
  if (record.datecreated !== undefined) row.dateCreated = calendarDate(record.datecreated);
  if (record.platform !== undefined) row.platform = record.platform;
  if (record.itemgroupid !== undefined) row.itemGroupId = record.itemgroupid;
  const varieties: ItemVarietyOption[] = [];
  for (const n of ["1", "2", "3"]) {
    const name = record[`customvariety${n}name`];
    const value = record[`customvariety${n}value`];
    if (name !== undefined && value !== undefined) varieties.push({ name, value });
  }
  if (varieties.length > 0) row.varieties = varieties;
  const extra = extras(record, KNOWN_ITEM_BASIC_INFO_KEYS);
  if (extra) row.extra = extra;
  return row;
}

export function priceRowFromRecord(record: RecordOfStrings): DailyPriceRow {
  const row: DailyPriceRow = {};
  if (record.sellerpartnumber !== undefined) row.sellerPartNumber = record.sellerpartnumber;
  if (record.neitemnumber !== undefined) row.neweggItemNumber = record.neitemnumber;
  if (record.countrycode !== undefined) row.countryCode = record.countrycode;
  if (record.currency !== undefined) row.currency = record.currency;
  const msrp = numberCell(record, "msrp");
  if (msrp !== undefined) row.msrp = msrp;
  const map = numberCell(record, "map");
  if (map !== undefined) row.map = map;
  const checkoutMap = boolCell(record, "checkoutmap");
  if (checkoutMap !== undefined) row.checkoutMap = checkoutMap;
  const sellingPrice = numberCell(record, "sellingprice");
  if (sellingPrice !== undefined) row.sellingPrice = sellingPrice;
  if (record.shipping !== undefined) row.shipping = record.shipping;
  const activationMark = boolCell(record, "activationmark");
  if (activationMark !== undefined) row.activationMark = activationMark;
  if (record.memo !== undefined) row.memo = record.memo;
  const extra = extras(record, KNOWN_PRICE_KEYS);
  if (extra) row.extra = extra;
  return row;
}
