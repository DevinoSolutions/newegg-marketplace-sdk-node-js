/**
 * Wire constants of the seller / category reference reads (contracts §19). Paths are relative
 * to the platform prefix (`""`, `b2b/`, `can/`).
 */

/** Seller Status Check (GET). */
export const SELLER_STATUS_PATH = "sellermgmt/seller/accountstatus";

/** Get Industry List (GET). */
export const INDUSTRY_PATH = "sellermgmt/seller/industry";

/** Get Subcategory Status (PUT). */
export const SUBCATEGORY_STATUS_PATH = "sellermgmt/seller/subcategory";

/** Get Subcategory Status for International Country (PUT, Newegg.com only; casing as documented). */
export const SUBCATEGORY_STATUS_INTERNATIONAL_PATH = "sellermgmt/seller/subcategory/V2";

/** Get Subcategory Properties (PUT). */
export const SUBCATEGORY_PROPERTY_PATH = "sellermgmt/seller/subcategoryproperty";

/** Get Subcategory Property Values (PUT). */
export const PROPERTY_VALUE_PATH = "sellermgmt/seller/propertyvalue";

/** Fixed `OperationType` of the Get Subcategory Status requests (both variants). */
export const SUBCATEGORY_STATUS_OPERATION_TYPE = "GetSellerSubcategoryRequest";

/** Fixed `OperationType` of Get Subcategory Properties. */
export const SUBCATEGORY_PROPERTY_OPERATION_TYPE = "GetSellerSubcategoryPropertyRequest";

/** Fixed `OperationType` of Get Subcategory Property Values. */
export const PROPERTY_VALUE_OPERATION_TYPE = "GetSellerPropertyValueRequest";
