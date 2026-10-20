/**
 * Constants of the Shipping Label Service (contracts §23). All three operations are `POST` to
 * `…/shippingservice/shippinglabel/<op>shippinglabel?sellerid=…` with a 1,000 req/hr budget each.
 */

export const SHIPPING_LABEL_CREATE_PATH = "shippingservice/shippinglabel/createshippinglabel";
export const SHIPPING_LABEL_ESTIMATE_PATH = "shippingservice/shippinglabel/estimateshippinglabel";
export const SHIPPING_LABEL_REPRINT_PATH = "shippingservice/shippinglabel/reprintshippinglabel";

export const SHIPPING_LABEL_CREATE_OPERATION_TYPE = "CreateShippingLabel";
export const SHIPPING_LABEL_ESTIMATE_OPERATION_TYPE = "EstimateShippingLabel";
export const SHIPPING_LABEL_REPRINT_OPERATION_TYPE = "ReprintShippingLabel";

/** `ShippingCarrierCode` 100 = "Newegg Partnered Carrier (UPS)", the only documented carrier. */
export const SHIPPING_CARRIER_CODE_UPS = 100;

/** Highest order number Newegg accepts (error SL001: "an integer ranging from 1 to 2147483647"). */
export const MAX_ORDER_NUMBER = 2147483647;

/**
 * UPS limits of the partnered carrier (the "Newegg Partnered Carrier - UPS" page; errors SL007 /
 * SL008 / SL009). Checked locally so an over-limit request fails before it is sent.
 */
export const UPS_MAX_WEIGHT_LB = 150;
export const UPS_MAX_LENGTH_IN = 108;
/** Length + 2 x width + 2 x height. */
export const UPS_MAX_LENGTH_PLUS_GIRTH_IN = 165;

/** SDK-chosen ceilings (the pages state none): a single request stays small and reviewable. */
export const SHIPPING_LABEL_MAX_PACKAGES = 20;
export const SHIPPING_LABEL_MAX_ITEMS_PER_PACKAGE = 100;

/** Wire value of `SignatureOptions` when the carrier must obtain a signature. */
export const SIGNATURE_REGULAR = "Regular";
