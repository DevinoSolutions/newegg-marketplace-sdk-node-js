/**
 * Per-marketplace differences of the Reports Management reports (contracts §17.4-§17.8). The
 * settlement reports are identical on every platform apart from which response fields come back,
 * which the tolerant parsers absorb; Daily Inventory / Daily Price differ in OperationType,
 * RequestType, criteria and (US) warehouse selection; Order List / RMA List differ in the
 * documented result `version`s and (Order List) in the US-only country / Premier criteria; Item
 * Basic Information is identical everywhere. All of that lives here rather than as `if`s in the
 * API layer (ADR 0002).
 */
import type {
  DailyInventoryInput,
  DailyPriceInput,
  ItemBasicInfoInput,
  NeweggMarketplace,
  OrderListInput,
  OrderListKeywordType,
  ReportTextFileType,
  RmaListInput,
} from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import {
  orderStatusToCode,
  orderTypeFilterToCode,
  premierOrderFilterToCode,
} from "../orders/constants.js";
import {
  rmaKeywordTypeToCode,
  rmaProcessedByToCode,
  rmaStatusToCode,
  rmaTypeToCode,
} from "../rma/constants.js";
import { normalizeDateRange, throwIfInvalid } from "../reports/validate.js";

/** `version` query Newegg documents as the only value for the daily reports (> 40,000 items → zip). */
const DAILY_REPORT_VERSION = "310";

const FULFILL_TYPE_CODES = { all: "0", seller: "1", newegg: "2" } as const;
const ITEM_BASIC_INFO_STATUS_CODES = { all: "0", active: "1", inactive: "2" } as const;
const ORDER_LIST_KEYWORD_CODES: Record<OrderListKeywordType, string> = {
  orderNumber: "1",
  invoiceNumber: "2",
  customerName: "3",
  sellerPartNumber: "4",
  neweggItemNumber: "5",
  customerPhoneNumber: "6",
  titleDescription: "7",
  manufacturer: "8",
  sellerOrderNumber: "9",
};
const ISO3 = /^[A-Z]{3}$/;

export interface FileReportRequest {
  /** Submit body. */
  body: unknown;
  /** Extra submit query (`version`). */
  query: Record<string, string>;
}

/** A paged report whose result carries a required `version` query (Order List, RMA List). */
export interface VersionedPagedRequest<Input> {
  /** `OperationType` of the submit AND of the result request. */
  readonly operationType: string;
  /** Documented result `version`s on this platform (§17.6), oldest first. */
  readonly versions: readonly string[];
  /** Used when the caller passes none. */
  readonly defaultVersion: string;
  /** Validates `input` and builds the submit body; throws `NeweggValidationError`. */
  buildSubmit(input: Input): unknown;
}

export interface ReportsPlatform {
  readonly marketplace: NeweggMarketplace;
  /** Item Basic Information (§17.8): the same request on every platform. */
  readonly itemBasicInfo: {
    readonly resultOperationType: string;
    buildRequest(input: ItemBasicInfoInput): FileReportRequest;
  };
  readonly orderList: VersionedPagedRequest<OrderListInput>;
  readonly rmaList: VersionedPagedRequest<RmaListInput>;
  readonly dailyInventory: {
    /** `OperationType` of the result request (differs from the submit response type). */
    readonly resultOperationType: string;
    buildRequest(input: DailyInventoryInput): FileReportRequest;
  };
  /** Newegg.com only (§17.5); undefined on B2B/CAN. */
  readonly dailyPrice?: {
    readonly resultOperationType: string;
    buildRequest(input: DailyPriceInput): FileReportRequest;
  };
}

function fileTypeOf(fileType: ReportTextFileType | undefined): string {
  return (fileType ?? "csv").toUpperCase();
}

function iso3List(values: string[] | undefined, path: string): string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const bad = values.filter((value) => !ISO3.test(value));
  if (bad.length > 0) {
    throw new NeweggValidationError("Report validation failed.", [
      { path, message: "must be uppercase 3-letter ISO country codes (e.g. USA)" },
    ]);
  }
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Item Basic Information (identical on every platform)
// ---------------------------------------------------------------------------
const itemBasicInfo: ReportsPlatform["itemBasicInfo"] = {
  resultOperationType: "ItemBasicInfoReportRequest",
  buildRequest(input: ItemBasicInfoInput): FileReportRequest {
    const status = input.status ?? "all";
    if (!(status in ITEM_BASIC_INFO_STATUS_CODES)) {
      throw new NeweggValidationError("Report validation failed.", [
        { path: "status", message: 'must be "all", "active" or "inactive"' },
      ]);
    }
    return {
      body: {
        OperationType: "ItemBasicInfoReportRequest",
        RequestBody: {
          ItemBasicInfoReportCriteria: {
            RequestType: "ITEM_BASIC_INFO_REPORT",
            Status: ITEM_BASIC_INFO_STATUS_CODES[status],
            FileType: fileTypeOf(input.fileType),
          },
        },
      },
      // No `version` query: the report was live-verified without one (contracts §17.8).
      query: {},
    };
  },
};

// ---------------------------------------------------------------------------
// Order List / RMA List
// ---------------------------------------------------------------------------
/** Order List (§17.6). Newegg.com alone offers the country / Premier criteria. */
function orderListRequest(
  marketplace: NeweggMarketplace,
  versions: readonly string[],
): VersionedPagedRequest<OrderListInput> {
  return {
    operationType: "OrderListReportRequest",
    versions,
    defaultVersion: "309",
    buildSubmit(input: OrderListInput): unknown {
      const issues: NeweggValidationIssue[] = [];
      const status = orderStatusToCode(input.status);
      if (status === undefined) {
        issues.push({ path: "status", message: "must be a concrete order status" });
      }
      if (input.keyword !== undefined) {
        if (!(input.keyword.type in ORDER_LIST_KEYWORD_CODES)) {
          issues.push({ path: "keyword.type", message: "unknown keyword type" });
        }
        if (input.keyword.value.trim() === "") {
          issues.push({ path: "keyword.value", message: "must be a non-empty string" });
        }
      }
      if (input.voidSoon !== undefined && input.voidSoon !== 24 && input.voidSoon !== 48) {
        issues.push({ path: "voidSoon", message: "must be 24 or 48" });
      }
      if (marketplace !== "us") {
        for (const field of ["countryCode", "premierOrder"] as const) {
          if (input[field] !== undefined) {
            issues.push({
              path: field,
              message: `${field} is Newegg.com only; it is not available on the ${marketplace} marketplace`,
            });
          }
        }
      }
      if (input.countryCode !== undefined && !ISO3.test(input.countryCode)) {
        issues.push({ path: "countryCode", message: "must be an uppercase 3-letter ISO code" });
      }
      const dates = normalizeDateRange(
        { from: input.dateFrom, to: input.dateTo },
        { from: "dateFrom", to: "dateTo" },
      );
      throwIfInvalid(issues);
      const criteria: Record<string, unknown> = {
        RequestType: "ORDER_LIST_REPORT",
        KeywordsType: input.keyword ? ORDER_LIST_KEYWORD_CODES[input.keyword.type] : "0",
        ...(input.keyword ? { KeywordsValue: input.keyword.value.trim() } : {}),
        Status: String(status),
        Type: String(orderTypeFilterToCode(input.type ?? "all")),
        ...(dates.from !== undefined ? { OrderDateFrom: dates.from } : {}),
        ...(dates.to !== undefined ? { OrderDateTo: dates.to } : {}),
        ...(input.voidSoon !== undefined ? { VoidSoon: String(input.voidSoon) } : {}),
        // Newegg's inverted flag: "false" includes downloaded orders (default), "true" excludes.
        ...(input.includeDownloaded === false ? { OrderDownloaded: "true" } : {}),
        ...(input.countryCode !== undefined ? { CountryCode: input.countryCode } : {}),
        ...(input.premierOrder !== undefined
          ? { PremierOrder: String(premierOrderFilterToCode(input.premierOrder)) }
          : {}),
      };
      return {
        OperationType: "OrderListReportRequest",
        RequestBody: { OrderReportCriteria: criteria },
      };
    },
  };
}

/** RMA List (§17.6): the same request everywhere; only the documented result versions differ. */
function rmaListRequest(versions: readonly string[]): VersionedPagedRequest<RmaListInput> {
  return {
    operationType: "RMAListReportRequest",
    versions,
    defaultVersion: "320",
    buildSubmit(input: RmaListInput): unknown {
      const issues: NeweggValidationIssue[] = [];
      if (input.keyword !== undefined && input.keyword.value.trim() === "") {
        issues.push({ path: "keyword.value", message: "must be a non-empty string" });
      }
      const dates = normalizeDateRange(
        { from: input.dateFrom, to: input.dateTo },
        { from: "dateFrom", to: "dateTo" },
      );
      throwIfInvalid(issues);
      const criteria: Record<string, unknown> = {
        RequestType: "RMA_LIST_REPORT",
        KeywordsType: input.keyword ? String(rmaKeywordTypeToCode(input.keyword.type)) : "0",
        ...(input.keyword ? { KeywordsValue: input.keyword.value.trim() } : {}),
        Status: input.status !== undefined ? String(rmaStatusToCode(input.status)) : "0",
        ...(dates.from !== undefined ? { RMADateFrom: dates.from } : {}),
        ...(dates.to !== undefined ? { RMADateTo: dates.to } : {}),
        RMAType: input.type !== undefined ? String(rmaTypeToCode(input.type)) : "0",
        ProcessedBy:
          input.processedBy !== undefined ? String(rmaProcessedByToCode(input.processedBy)) : "0",
      };
      return {
        OperationType: "RMAListReportRequest",
        RequestBody: { RMAListReportCriteria: criteria },
      };
    },
  };
}

/** Resolves a requested result `version` against the platform's documented set. */
export function resolveVersion(
  request: Pick<VersionedPagedRequest<never>, "versions" | "defaultVersion">,
  requested?: string,
): string {
  const version = requested ?? request.defaultVersion;
  if (!request.versions.includes(version)) {
    const message = `must be one of ${request.versions.join(", ")}`;
    throw new NeweggValidationError(`Report validation failed: version: ${message}`, [
      { path: "version", message },
    ]);
  }
  return version;
}

// ---------------------------------------------------------------------------
// Daily Inventory / Daily Price
// ---------------------------------------------------------------------------
const usReports: ReportsPlatform = {
  marketplace: "us",
  itemBasicInfo,
  orderList: orderListRequest("us", ["306", "307", "309", "310"]),
  rmaList: rmaListRequest(["306", "307", "309", "320"]),
  dailyInventory: {
    resultOperationType: "InternationalInventoryReportRequest",
    buildRequest(input: DailyInventoryInput): FileReportRequest {
      const warehouses = iso3List(input.warehouses, "warehouses");
      const criteria: Record<string, unknown> = {
        FulfillType: FULFILL_TYPE_CODES[input.fulfillType ?? "all"],
        ...(warehouses !== undefined ? { WarehouseList: { WarehouseLocation: warehouses } } : {}),
        RequestType: "INTERNATIONAL_INVENTORY_REPORT",
        FileType: fileTypeOf(input.fileType),
      };
      return {
        body: {
          OperationType: "InternationalInventoryReportRequest",
          RequestBody: { DailyInventoryReportCriteria: criteria },
        },
        query: { version: DAILY_REPORT_VERSION },
      };
    },
  },
  dailyPrice: {
    resultOperationType: "InternationalPriceReportRequest",
    buildRequest(input: DailyPriceInput): FileReportRequest {
      const countries = iso3List(input.countries, "countries");
      const criteria: Record<string, unknown> = {
        ...(countries !== undefined ? { CountryList: { CountryCode: countries } } : {}),
        RequestType: "INTERNATIONAL_PRICE_REPORT",
        FileType: fileTypeOf(input.fileType),
      };
      return {
        body: {
          OperationType: "InternationalPriceReportRequest",
          RequestBody: { DailyPriceReportCriteria: criteria },
        },
        query: { version: DAILY_REPORT_VERSION },
      };
    },
  },
};

/** B2B and CAN share the default-warehouse Daily Inventory report (price + activation columns). */
function itemReports(marketplace: "b2b" | "ca"): ReportsPlatform {
  return {
    marketplace,
    itemBasicInfo,
    orderList: orderListRequest(
      marketplace,
      marketplace === "b2b" ? ["305", "306", "309"] : ["305", "309"],
    ),
    rmaList: rmaListRequest(["305", "309", "320"]),
    dailyInventory: {
      resultOperationType: "DailyInventoryReportRequest",
      buildRequest(input: DailyInventoryInput): FileReportRequest {
        if (input.warehouses !== undefined && input.warehouses.length > 0) {
          throw new NeweggValidationError("Report validation failed.", [
            {
              path: "warehouses",
              message: `warehouses is US-only; ${marketplace.toUpperCase()} reports the single default warehouse`,
            },
          ]);
        }
        return {
          body: {
            OperationType: "DailyInventoryReportRequest",
            RequestBody: {
              DailyInventoryReportCriteria: {
                FulfillType: FULFILL_TYPE_CODES[input.fulfillType ?? "all"],
                RequestType: "DAILY_INVENTORY_REPORT",
                FileType: fileTypeOf(input.fileType),
              },
            },
          },
          query: { version: DAILY_REPORT_VERSION },
        };
      },
    },
  };
}

const b2bReports = itemReports("b2b");
const caReports = itemReports("ca");

/** Returns the reports platform data for a marketplace. */
export function getReportsPlatform(marketplace: NeweggMarketplace): ReportsPlatform {
  switch (marketplace) {
    case "us":
      return usReports;
    case "b2b":
      return b2bReports;
    case "ca":
      return caReports;
  }
}
