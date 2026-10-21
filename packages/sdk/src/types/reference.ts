/** Seller / category reference types (contracts §19). Re-exported from `../types.ts`. */

import type { NeweggMarketplace, RequestOptions } from "./common.js";
import type { RateLimitInfo } from "./runtime.js";

// ----------------------------------------------------------------------------
// seller / category reference reads (contracts §19)
// ----------------------------------------------------------------------------
/** `Status` of Seller Status Check; anything outside the five documented values is `"unknown"`. */
export type SellerAccountStatus =
  "active" | "suspended" | "inactive" | "terminated" | "closed" | "unknown";

/** `Membership` code of Seller Status Check (0 / 1 / 2); documented for Newegg.com only. */
export type SellerMembership = "nonElite" | "professional" | "enterprise" | "unknown";

/** One fulfillment center of a Newegg.com seller account (`FufillmentCenter`, sic). */
export interface SellerFulfillmentCenter {
  /** ISO 3166-1 alpha-3 country of the warehouse. */
  warehouseLocation?: string;
  /** `WarehouseType` 0 = Ship by Seller, 1 = Ship by Newegg. */
  shippedBy?: "seller" | "newegg";
  /** ISO alpha-3 destination countries this center ships to. */
  shipToCountries: string[];
}

/** Result of {@link ReferenceApi.getSellerStatus}. */
export interface SellerStatus {
  marketplace: NeweggMarketplace;
  sellerName?: string;
  status: SellerAccountStatus;
  /** The `Status` text exactly as Newegg sent it. */
  statusText?: string;
  /** Undefined when the platform sends no membership (documented for Newegg.com only). */
  membership?: SellerMembership;
  /** Newegg.com only; empty on B2B/CAN, whose pages document no fulfillment center list. */
  fulfillmentCenters: SellerFulfillmentCenter[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** One Newegg industry (`IndustryCode` + `IndustryName`). */
export interface Industry {
  code: string;
  name?: string;
}

/** Criteria for {@link ReferenceApi.listIndustries}. */
export interface ListIndustriesInput {
  /** Return only this industry; omit for every industry. An unknown code returns an empty list (live, contracts §19.3). */
  industryCode?: string;
}

/** Result of {@link ReferenceApi.listIndustries}. */
export interface IndustriesResult {
  marketplace: NeweggMarketplace;
  industries: Industry[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Criteria for {@link ReferenceApi.listSubcategories}. Every field is optional. */
export interface ListSubcategoriesInput {
  /** Restrict to these Newegg subcategory ids. */
  subcategoryIds?: number[];
  /** Restrict to these industry codes (see {@link ReferenceApi.listIndustries}). */
  industryCodes?: string[];
  /** `true` = only enabled subcategories, `false` = only not-enabled; omit for both. */
  enabled?: boolean;
  /**
   * ISO alpha-3 country to check eligibility in (Get Subcategory Status for International
   * Country). Newegg.com only; B2B/CAN throw {@link UnsupportedMarketplaceOperationError}.
   */
  countryCode?: string;
}

/** One subcategory and whether it is enabled for the seller. */
export interface SubcategoryStatus {
  industryCode?: string;
  industryName?: string;
  subcategoryId: number;
  subcategoryName?: string;
  /** Undefined when Newegg sent no (or an unparseable) `Enabled`; never assumed `false`. */
  enabled?: boolean;
}

/** Result of {@link ReferenceApi.listSubcategories}. */
export interface SubcategoriesResult {
  marketplace: NeweggMarketplace;
  /** Echoed `CountryCode` of the international variant; undefined for the standard call. */
  countryCode?: string;
  subcategories: SubcategoryStatus[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** One property of a subcategory. */
export interface SubcategoryProperty {
  subcategoryId?: number;
  subcategoryName?: string;
  /** The exact name item-creation feeds and {@link ReferenceApi.listPropertyValues} expect. */
  propertyName: string;
  isAdvancedSearch?: boolean;
  isGroupBy?: boolean;
  isRequired?: boolean;
}

/** Result of {@link ReferenceApi.listSubcategoryProperties}. */
export interface SubcategoryPropertiesResult {
  marketplace: NeweggMarketplace;
  subcategoryId: number;
  properties: SubcategoryProperty[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/** Criteria for {@link ReferenceApi.listPropertyValues}. */
export interface ListPropertyValuesInput {
  /** Property name as returned by {@link ReferenceApi.listSubcategoryProperties}. */
  propertyName: string;
  /** Subcategory the property belongs to; live Newegg rejects the request without it (CE003). */
  subcategoryId: number;
}

/** A property with its allowed values (rows Newegg splits one-value-per-row are merged). */
export interface PropertyValues extends SubcategoryProperty {
  values: string[];
}

/** Result of {@link ReferenceApi.listPropertyValues}. */
export interface PropertyValuesResult {
  marketplace: NeweggMarketplace;
  properties: PropertyValues[];
  correlationId: string;
  rateLimit?: RateLimitInfo;
  raw?: unknown;
}

/**
 * Seller / category reference reads (contracts §19): account status, industries, subcategory
 * eligibility, and the property metadata item creation needs. All are READS (some via `PUT`);
 * none mutates the seller account.
 */
export interface ReferenceApi {
  /** Seller Status Check: account status, store name, membership and fulfillment centers. */
  getSellerStatus(options?: RequestOptions): Promise<SellerStatus>;
  /** Get Industry List (10,000 req/hr). */
  listIndustries(input?: ListIndustriesInput, options?: RequestOptions): Promise<IndustriesResult>;
  /**
   * Get Subcategory Status, or its international variant when `countryCode` is set. The
   * request budget is shared with the other PUT reads and the live header reports less than the
   * docs state (contracts §19.1).
   */
  listSubcategories(
    input?: ListSubcategoriesInput,
    options?: RequestOptions,
  ): Promise<SubcategoriesResult>;
  /** Get Subcategory Properties. Shares the PUT-read budget (contracts §19.1). */
  listSubcategoryProperties(
    subcategoryId: number,
    options?: RequestOptions,
  ): Promise<SubcategoryPropertiesResult>;
  /** Get Subcategory Property Values. Shares the PUT-read budget (contracts §19.1). */
  listPropertyValues(
    input: ListPropertyValuesInput,
    options?: RequestOptions,
  ): Promise<PropertyValuesResult>;
}
