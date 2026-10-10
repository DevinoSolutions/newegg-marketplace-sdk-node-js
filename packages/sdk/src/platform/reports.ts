/**
 * Per-marketplace differences of the file-style Reports Management reports (contracts §17.4/§17.5).
 * The settlement reports are identical on every platform apart from which response fields come
 * back, which the tolerant parsers absorb; Daily Inventory / Daily Price differ in OperationType,
 * RequestType, criteria and (US) warehouse selection, so those live here rather than as `if`s in
 * the API layer (ADR 0002).
 */
import type {
  DailyInventoryInput,
  DailyPriceInput,
  NeweggMarketplace,
  ReportTextFileType,
} from "../types.js";
import { NeweggValidationError } from "../errors/index.js";

/** `version` query Newegg documents as the only value for the daily reports (> 40,000 items → zip). */
const DAILY_REPORT_VERSION = "310";

const FULFILL_TYPE_CODES = { all: "0", seller: "1", newegg: "2" } as const;
const ISO3 = /^[A-Z]{3}$/;

export interface FileReportRequest {
  /** Submit body. */
  body: unknown;
  /** Extra submit query (`version`). */
  query: Record<string, string>;
}

export interface ReportsPlatform {
  readonly marketplace: NeweggMarketplace;
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

const usReports: ReportsPlatform = {
  marketplace: "us",
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
