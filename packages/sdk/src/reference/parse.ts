/**
 * Pure request builders and tolerant response parsers for the seller / category reference reads
 * (contracts §19). Free of transport concerns so they can be unit-tested against raw wire
 * fixtures. Every reader tolerates Newegg's quirks: numbers as strings, booleans as
 * "0"/"1"/"true", single-element lists as objects (or bare strings) instead of arrays, empty
 * lists as `""`, and the optional `NeweggAPIResponse` wrapper.
 */
import type {
  Industry,
  ListIndustriesInput,
  ListPropertyValuesInput,
  ListSubcategoriesInput,
  PropertyValues,
  SellerAccountStatus,
  SellerFulfillmentCenter,
  SellerMembership,
  SubcategoryProperty,
  SubcategoryStatus,
} from "../types.js";
import { NeweggApiError } from "../errors/index.js";
import type { NeweggValidationIssue } from "../errors/index.js";
import { asArray, asBoolean, asNumber, asString, getField, isRecord } from "../schemas/wire.js";
import { listItems, throwIfInvalid, unwrapResponse } from "../servicemgmt/shared.js";
import {
  PROPERTY_VALUE_OPERATION_TYPE,
  SUBCATEGORY_PROPERTY_OPERATION_TYPE,
  SUBCATEGORY_STATUS_OPERATION_TYPE,
} from "./constants.js";

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------
const INDUSTRY_CODE_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{3}$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const MAX_LIST_FILTER = 200;
const MAX_PROPERTY_NAME_LENGTH = 200;

function checkIndustryCode(value: unknown, path: string, issues: NeweggValidationIssue[]): void {
  if (typeof value !== "string" || !INDUSTRY_CODE_PATTERN.test(value)) {
    issues.push({ path, message: "must be 1-20 letters, digits, '_' or '-'" });
  }
}

function checkSubcategoryId(value: unknown, path: string, issues: NeweggValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    issues.push({ path, message: "must be a positive integer" });
  }
}

/** Validates a standalone `subcategoryId` argument (throws {@link NeweggValidationError}). */
export function validateSubcategoryId(subcategoryId: number): number {
  const issues: NeweggValidationIssue[] = [];
  checkSubcategoryId(subcategoryId, "subcategoryId", issues);
  throwIfInvalid("Invalid subcategory request.", issues);
  return subcategoryId;
}

// ---------------------------------------------------------------------------
// request builders
// ---------------------------------------------------------------------------
/** Query of Get Industry List (`industrycode` only when filtering). */
export function buildIndustryQuery(input: ListIndustriesInput): Record<string, string> | undefined {
  if (input.industryCode === undefined) return undefined;
  const issues: NeweggValidationIssue[] = [];
  checkIndustryCode(input.industryCode, "industryCode", issues);
  throwIfInvalid("Invalid industry request.", issues);
  return { industrycode: input.industryCode };
}

/**
 * Body of Get Subcategory Status (both variants). Follows the official samples: the filters
 * nest under `GetItemSubcategory` as `SubcategoryIDList` / `IndustryCodeList` / `Enabled`, with
 * every wire value a string; `CountryCode` (international variant) sits beside it.
 */
export function buildSubcategoryStatusBody(input: ListSubcategoriesInput): unknown {
  const issues: NeweggValidationIssue[] = [];
  const { subcategoryIds, industryCodes, enabled, countryCode } = input;
  if (subcategoryIds !== undefined) {
    if (!Array.isArray(subcategoryIds) || subcategoryIds.length > MAX_LIST_FILTER) {
      issues.push({
        path: "subcategoryIds",
        message: `must be an array of at most ${MAX_LIST_FILTER} ids`,
      });
    } else {
      subcategoryIds.forEach((id, i) => checkSubcategoryId(id, `subcategoryIds.${i}`, issues));
    }
  }
  if (industryCodes !== undefined) {
    if (!Array.isArray(industryCodes) || industryCodes.length > MAX_LIST_FILTER) {
      issues.push({
        path: "industryCodes",
        message: `must be an array of at most ${MAX_LIST_FILTER} codes`,
      });
    } else {
      industryCodes.forEach((code, i) => checkIndustryCode(code, `industryCodes.${i}`, issues));
    }
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    issues.push({ path: "enabled", message: "must be a boolean" });
  }
  if (countryCode !== undefined && !COUNTRY_CODE_PATTERN.test(countryCode)) {
    issues.push({ path: "countryCode", message: "must be an uppercase ISO alpha-3 code" });
  }
  throwIfInvalid("Invalid subcategory request.", issues);

  const filter: Record<string, unknown> = {};
  if (subcategoryIds !== undefined && subcategoryIds.length > 0) {
    filter.SubcategoryIDList = { SubcategoryID: subcategoryIds.map(String) };
  }
  if (industryCodes !== undefined && industryCodes.length > 0) {
    filter.IndustryCodeList = { IndustryCode: [...industryCodes] };
  }
  if (enabled !== undefined) filter.Enabled = enabled ? "1" : "0";

  const requestBody: Record<string, unknown> = {};
  if (countryCode !== undefined) requestBody.CountryCode = countryCode;
  requestBody.GetItemSubcategory = filter;
  return { OperationType: SUBCATEGORY_STATUS_OPERATION_TYPE, RequestBody: requestBody };
}

/** Body of Get Subcategory Properties. */
export function buildSubcategoryPropertyBody(subcategoryId: number): unknown {
  return {
    OperationType: SUBCATEGORY_PROPERTY_OPERATION_TYPE,
    RequestBody: { SubcategoryID: String(subcategoryId) },
  };
}

/** Body of Get Subcategory Property Values (`PropertyName` required, `SubcategoryID` optional). */
export function buildPropertyValueBody(input: ListPropertyValuesInput): unknown {
  const issues: NeweggValidationIssue[] = [];
  const name = typeof input.propertyName === "string" ? input.propertyName.trim() : "";
  if (name === "" || name.length > MAX_PROPERTY_NAME_LENGTH || CONTROL_CHARACTERS.test(name)) {
    issues.push({
      path: "propertyName",
      message: `must be 1-${MAX_PROPERTY_NAME_LENGTH} characters without control characters`,
    });
  }
  if (input.subcategoryId !== undefined) {
    checkSubcategoryId(input.subcategoryId, "subcategoryId", issues);
  }
  throwIfInvalid("Invalid property value request.", issues);
  const requestBody: Record<string, unknown> = {};
  if (input.subcategoryId !== undefined) requestBody.SubcategoryID = String(input.subcategoryId);
  requestBody.PropertyName = name;
  return { OperationType: PROPERTY_VALUE_OPERATION_TYPE, RequestBody: requestBody };
}

// ---------------------------------------------------------------------------
// response helpers
// ---------------------------------------------------------------------------
/**
 * Unwraps the response and turns a 200 whose body is a bare error list (`[{Code, Message}]`)
 * into a {@link NeweggApiError}, so an error can never read as an empty result.
 */
function unwrapReference(json: unknown, correlationId: string): unknown {
  if (Array.isArray(json)) {
    const first = json.find(isRecord);
    const code = asString(getField(first, "Code"));
    if (code !== undefined) {
      throw new NeweggApiError(`Newegg returned an error list (${code}).`, {
        correlationId,
        neweggErrorCode: code,
        details: { message: asString(getField(first, "Message")) },
      });
    }
  }
  return unwrapResponse(json, correlationId).body;
}

/**
 * Reads a list of plain strings that may be a JSON array, an XML-style `{ Inner: ... }` wrapper
 * (object, array or bare string), a single bare string, or `""` when empty.
 */
function stringList(container: unknown, innerKey: string): string[] {
  const source = isRecord(container) ? (container[innerKey] ?? []) : container;
  return asArray(source)
    .map(asString)
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .map((value) => value.trim());
}

function text(value: unknown): string | undefined {
  const s = asString(value)?.trim();
  return s === undefined || s === "" ? undefined : s;
}

// ---------------------------------------------------------------------------
// Seller Status Check
// ---------------------------------------------------------------------------
function sellerStatusFromText(raw: string | undefined): SellerAccountStatus {
  switch (raw?.trim().toLowerCase()) {
    case "active":
      return "active";
    case "suspended":
      return "suspended";
    case "inactive":
      return "inactive";
    case "terminated":
      return "terminated";
    case "closed":
      return "closed";
    default:
      return "unknown";
  }
}

function membershipFromCode(code: number | undefined): SellerMembership | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case 0:
      return "nonElite";
    case 1:
      return "professional";
    case 2:
      return "enterprise";
    default:
      return "unknown";
  }
}

function parseFulfillmentCenter(center: unknown): SellerFulfillmentCenter {
  const warehouseType = asNumber(getField(center, "WarehouseType"));
  return {
    warehouseLocation: text(getField(center, "WarehouseLocation")),
    shippedBy: warehouseType === 0 ? "seller" : warehouseType === 1 ? "newegg" : undefined,
    shipToCountries: stringList(getField(center, "ShippingDestinationList"), "ShipToCountry"),
  };
}

export interface ParsedSellerStatus {
  sellerName?: string;
  status: SellerAccountStatus;
  statusText?: string;
  membership?: SellerMembership;
  fulfillmentCenters: SellerFulfillmentCenter[];
}

/** Parses Seller Status Check. The list key is spelled `FufillmentCenterList` (sic) on the wire. */
export function parseSellerStatus(json: unknown, correlationId: string): ParsedSellerStatus {
  const body = unwrapReference(json, correlationId);
  const statusText = text(getField(body, "Status"));
  const centers = getField(body, "FufillmentCenterList") ?? getField(body, "FulfillmentCenterList");
  return {
    sellerName: text(getField(body, "SellerName")),
    status: sellerStatusFromText(statusText),
    statusText,
    membership: membershipFromCode(asNumber(getField(body, "Membership"))),
    fulfillmentCenters: listItems(centers, "FufillmentCenter", "FulfillmentCenter").map(
      parseFulfillmentCenter,
    ),
  };
}

// ---------------------------------------------------------------------------
// Industry list
// ---------------------------------------------------------------------------
/** Parses Get Industry List (`IndustryList > Industry[]`); rows without a code are dropped. */
export function parseIndustries(json: unknown, correlationId: string): Industry[] {
  const body = unwrapReference(json, correlationId);
  const industries: Industry[] = [];
  for (const row of listItems(getField(body, "IndustryList"), "Industry")) {
    const code = text(getField(row, "IndustryCode"));
    if (code !== undefined) industries.push({ code, name: text(getField(row, "IndustryName")) });
  }
  return industries;
}

// ---------------------------------------------------------------------------
// Subcategory status
// ---------------------------------------------------------------------------
export interface ParsedSubcategories {
  countryCode?: string;
  subcategories: SubcategoryStatus[];
}

/** Parses Get Subcategory Status (both variants); rows without a numeric id are dropped. */
export function parseSubcategories(json: unknown, correlationId: string): ParsedSubcategories {
  const body = unwrapReference(json, correlationId);
  const subcategories: SubcategoryStatus[] = [];
  for (const row of listItems(getField(body, "SubcategoryList"), "Subcategory")) {
    const subcategoryId = asNumber(getField(row, "SubcategoryID"));
    if (subcategoryId === undefined) continue;
    subcategories.push({
      industryCode: text(getField(row, "IndustryCode")),
      industryName: text(getField(row, "IndustryName")),
      subcategoryId,
      subcategoryName: text(getField(row, "SubcategoryName")),
      enabled: asBoolean(getField(row, "Enabled")),
    });
  }
  return { countryCode: text(getField(body, "CountryCode")), subcategories };
}

// ---------------------------------------------------------------------------
// Subcategory properties and property values
// ---------------------------------------------------------------------------
function parsePropertyFields(row: unknown): SubcategoryProperty | undefined {
  const propertyName = text(getField(row, "PropertyName"));
  if (propertyName === undefined) return undefined;
  return {
    subcategoryId: asNumber(getField(row, "SubcategoryID")),
    subcategoryName: text(getField(row, "SubcategoryName")),
    propertyName,
    isAdvancedSearch: asBoolean(getField(row, "IsAdvancedSearch")),
    isGroupBy: asBoolean(getField(row, "IsGroupBy")),
    isRequired: asBoolean(getField(row, "IsRequired")),
  };
}

/** Parses Get Subcategory Properties (`SubcategoryPropertyList > SubcategoryProperty[]`). */
export function parseSubcategoryProperties(
  json: unknown,
  correlationId: string,
): SubcategoryProperty[] {
  const body = unwrapReference(json, correlationId);
  return listItems(getField(body, "SubcategoryPropertyList"), "SubcategoryProperty")
    .map(parsePropertyFields)
    .filter((property): property is SubcategoryProperty => property !== undefined);
}

/**
 * Parses Get Subcategory Property Values (`PropertyInfoList > PropertyInfo[]`). The official
 * samples emit one row per value, each with a one-element `PropertyValueList`; rows for the same
 * (subcategory, property) are merged into one entry with all its values, de-duplicated, in order.
 */
export function parsePropertyValues(json: unknown, correlationId: string): PropertyValues[] {
  const body = unwrapReference(json, correlationId);
  const merged = new Map<string, PropertyValues>();
  for (const row of listItems(getField(body, "PropertyInfoList"), "PropertyInfo")) {
    const fields = parsePropertyFields(row);
    if (fields === undefined) continue;
    const key = `${fields.subcategoryId ?? ""}|${fields.propertyName}`;
    let entry = merged.get(key);
    if (entry === undefined) {
      entry = { ...fields, values: [] };
      merged.set(key, entry);
    }
    for (const value of stringList(getField(row, "PropertyValueList"), "PropertyValue")) {
      if (!entry.values.includes(value)) entry.values.push(value);
    }
  }
  return [...merged.values()];
}
