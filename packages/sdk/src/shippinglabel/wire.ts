/**
 * Pure request builders and tolerant response parsers for the Shipping Label Service (contracts
 * §23). Free of transport concerns so they can be unit-tested against raw wire fixtures. Request
 * values are STRINGS, exactly as in the pages' JSON samples, wrapped in the `NeweggAPIRequest`
 * envelope the samples show. Responses arrive under `NeweggAPIResponse` (create / estimate) or,
 * per the reprint page, `NeweggAPIRequest`; lists may be an object or an array.
 */
import type {
  ShippingLabelEstimate,
  ShippingLabelEstimatePackage,
  ShippingLabelInput,
  ShippingLabelItem,
  ShippingLabelPackageResult,
  ShippingLabelRate,
} from "../types.js";
import { NeweggApiError } from "../errors/index.js";
import { toTimestamp } from "../platform/dates.js";
import { asBoolean, asNumber, asString, getField } from "../schemas/wire.js";
import { listItems } from "../servicemgmt/shared.js";
import {
  SHIPPING_CARRIER_CODE_UPS,
  SHIPPING_LABEL_CREATE_OPERATION_TYPE,
  SHIPPING_LABEL_ESTIMATE_OPERATION_TYPE,
  SHIPPING_LABEL_REPRINT_OPERATION_TYPE,
  SIGNATURE_REGULAR,
} from "./constants.js";

/** One value stays a bare object and several become an array (the usual object-or-array quirk). */
function oneOrMany<T>(values: readonly T[]): T | T[] {
  return values.length === 1 ? (values[0] as T) : [...values];
}

function shipmentBody(input: ShippingLabelInput): Record<string, unknown> {
  const { shipFrom } = input;
  const shipment: Record<string, unknown> = {
    OrderNumber: String(input.orderNumber),
    ShippingCarrierCode: String(SHIPPING_CARRIER_CODE_UPS),
  };
  if (input.serviceCode !== undefined) shipment.ShippingServiceCode = String(input.serviceCode);
  shipment.ShipFromFirstName = shipFrom.firstName;
  shipment.ShipFromLastName = shipFrom.lastName;
  shipment.ShipFromPhoneNumber = shipFrom.phoneNumber;
  shipment.ShipFromAddress1 = shipFrom.address1;
  if (shipFrom.address2 !== undefined) shipment.ShipFromAddress2 = shipFrom.address2;
  shipment.ShipFromCityName = shipFrom.city;
  shipment.ShipFromStateCode = shipFrom.stateCode;
  // The field table says `ShpFromZipCode`; both samples (XML and JSON) say `ShipFromZipCode`.
  shipment.ShipFromZipCode = shipFrom.zipCode;
  shipment.ShipFromCountryCode = shipFrom.countryCode;
  shipment.PackageList = {
    Package: oneOrMany(
      input.packages.map((pkg) => {
        const row: Record<string, unknown> = {
          PackageWeight: String(pkg.weightLb),
          PackageLength: String(pkg.lengthIn),
          PackageHeight: String(pkg.heightIn),
          PackageWidth: String(pkg.widthIn),
        };
        if (pkg.signatureRequired === true) row.SignatureOptions = SIGNATURE_REGULAR;
        row.ItemList = {
          Item: oneOrMany(
            pkg.items.map((item) => ({
              SellerPartNumber: item.sellerPartNumber,
              Quantity: String(item.quantity),
            })),
          ),
        };
        return row;
      }),
    ),
  };
  return shipment;
}

function envelope(
  operationType: string,
  sellerId: string,
  shipment: Record<string, unknown>,
): unknown {
  return {
    NeweggAPIRequest: {
      OperationType: operationType,
      SellerID: sellerId,
      RequestBody: { Shipment: shipment },
    },
  };
}

/** Shipping Label Request body (`CreateShippingLabel`). */
export function buildCreateLabelBody(input: ShippingLabelInput, sellerId: string): unknown {
  return envelope(SHIPPING_LABEL_CREATE_OPERATION_TYPE, sellerId, shipmentBody(input));
}

/** Shipping Label Estimate Request body (`EstimateShippingLabel`): same shipment as create. */
export function buildEstimateLabelBody(input: ShippingLabelInput, sellerId: string): unknown {
  return envelope(SHIPPING_LABEL_ESTIMATE_OPERATION_TYPE, sellerId, shipmentBody(input));
}

/** Shipping Label Reprint Request body (`ReprintShippingLabel`): the order number only. */
export function buildReprintLabelBody(orderNumber: string, sellerId: string): unknown {
  return envelope(SHIPPING_LABEL_REPRINT_OPERATION_TYPE, sellerId, { OrderNumber: orderNumber });
}

// ---------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------
/** The `Shipment` of a response, whichever envelope root Newegg used. Throws on `IsSuccess=false`. */
function shipmentOf(json: unknown, correlationId: string): Record<string, unknown> | undefined {
  const root = getField(json, "NeweggAPIResponse") ?? getField(json, "NeweggAPIRequest") ?? json;
  if (asBoolean(getField(root, "IsSuccess")) === false) {
    throw new NeweggApiError("Newegg reported the request as unsuccessful (IsSuccess=false).", {
      correlationId,
      details: { memo: asString(getField(root, "Memo")) },
    });
  }
  const body = getField(root, "ResponseBody") ?? root;
  const shipment = getField(body, "Shipment");
  return shipment !== null && typeof shipment === "object" && !Array.isArray(shipment)
    ? (shipment as Record<string, unknown>)
    : undefined;
}

function packagesOf(shipment: unknown): unknown[] {
  return listItems(getField(shipment, "PackageList"), "Package");
}

function itemsOf(pkg: unknown): ShippingLabelItem[] {
  const out: ShippingLabelItem[] = [];
  for (const row of listItems(getField(pkg, "ItemList"), "Item")) {
    const sellerPartNumber = asString(getField(row, "SellerPartNumber"));
    if (sellerPartNumber === undefined) continue;
    out.push({ sellerPartNumber, quantity: asNumber(getField(row, "Quantity")) ?? 0 });
  }
  return out;
}

/** A package is a success when `ProcessResult` says so (or is absent but a tracking number exists). */
function succeededOf(pkg: unknown, hasEvidence: boolean): boolean {
  const result = asString(getField(pkg, "ProcessResult"))?.trim().toLowerCase();
  if (result === undefined || result === "") return hasEvidence;
  return result === "success" || result === "succeeded" || result === "true";
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function rateOf(
  rate: unknown,
  keys: { weight: string; arrive: string; amount: string; signature: string; total: string },
): ShippingLabelRate | undefined {
  if (rate === undefined || rate === null || typeof rate !== "object") return undefined;
  const parsed: ShippingLabelRate = {};
  const weight = asNumber(getField(rate, keys.weight));
  if (weight !== undefined) parsed.shipWeight = weight;
  const arriveBy = toTimestamp(asString(getField(rate, keys.arrive)));
  if (arriveBy !== undefined) parsed.arriveBy = arriveBy;
  const amount = asNumber(getField(rate, keys.amount));
  if (amount !== undefined) parsed.shippingAmount = amount;
  const signature = asNumber(getField(rate, keys.signature));
  if (signature !== undefined) parsed.signatureAmount = signature;
  const total = asNumber(getField(rate, keys.total));
  if (total !== undefined) parsed.total = total;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

const BILLED_KEYS = {
  weight: "ShipWeight",
  arrive: "ArriveBy",
  amount: "ShippingAmount",
  signature: "SignatureOptions",
  total: "Total",
} as const;

const ESTIMATED_KEYS = {
  weight: "EstimatedShipWeight",
  arrive: "EstimatedArriveBy",
  amount: "EstimatedShippingAmount",
  signature: "EstimatedSignatureOptions",
  total: "EstimatedTotal",
} as const;

function packageResultOf(pkg: unknown, withRate: boolean): ShippingLabelPackageResult {
  const trackingNumber = nonEmpty(asString(getField(pkg, "TrackingNumber")));
  const labelUrl = nonEmpty(asString(getField(pkg, "LabelUrl")));
  const result: ShippingLabelPackageResult = {
    succeeded: succeededOf(pkg, trackingNumber !== undefined || labelUrl !== undefined),
    signatureRequired:
      asString(getField(pkg, "SignatureOptions"))?.trim().toLowerCase() ===
      SIGNATURE_REGULAR.toLowerCase(),
    items: itemsOf(pkg),
  };
  const errorMessage = nonEmpty(asString(getField(pkg, "ErrorMessage")));
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  if (trackingNumber !== undefined) result.trackingNumber = trackingNumber;
  if (labelUrl !== undefined) result.labelUrl = labelUrl;
  // The table names the field `PackageListUrl`, both samples `PackingListUrl`: read either.
  const packingListUrl = nonEmpty(
    asString(getField(pkg, "PackingListUrl")) ?? asString(getField(pkg, "PackageListUrl")),
  );
  if (packingListUrl !== undefined) result.packingListUrl = packingListUrl;
  if (withRate) {
    const rate = rateOf(getField(pkg, "Rate"), BILLED_KEYS);
    if (rate !== undefined) result.rate = rate;
  }
  return result;
}

/** Parsed Shipping Label Request answer. */
export interface ParsedCreateLabel {
  orderNumber: string;
  shipDate?: { raw: string; iso?: string };
  packages: ShippingLabelPackageResult[];
}

export function parseCreateLabelResponse(json: unknown, correlationId: string): ParsedCreateLabel {
  const shipment = shipmentOf(json, correlationId);
  const parsed: ParsedCreateLabel = {
    orderNumber: asString(getField(shipment, "OrderNumber")) ?? "",
    packages: packagesOf(shipment).map((pkg) => packageResultOf(pkg, true)),
  };
  const shipDate = toTimestamp(asString(getField(shipment, "ShipDate")));
  if (shipDate !== undefined) parsed.shipDate = shipDate;
  return parsed;
}

/** Parsed Shipping Label Reprint answer. */
export interface ParsedReprintLabel {
  orderNumber: string;
  orderStatus?: string;
  packages: ShippingLabelPackageResult[];
}

export function parseReprintLabelResponse(
  json: unknown,
  correlationId: string,
): ParsedReprintLabel {
  const shipment = shipmentOf(json, correlationId);
  const parsed: ParsedReprintLabel = {
    orderNumber: asString(getField(shipment, "OrderNumber")) ?? "",
    packages: packagesOf(shipment).map((pkg) => packageResultOf(pkg, false)),
  };
  const orderStatus = nonEmpty(asString(getField(shipment, "OrderStatus")));
  if (orderStatus !== undefined) parsed.orderStatus = orderStatus;
  return parsed;
}

/** Parsed Shipping Label Estimate answer. */
export type ParsedEstimateLabel = Pick<
  ShippingLabelEstimate,
  "orderNumber" | "estimatedDate" | "packages" | "estimatedTotal"
>;

export function parseEstimateLabelResponse(
  json: unknown,
  correlationId: string,
): ParsedEstimateLabel {
  const shipment = shipmentOf(json, correlationId);
  const packages: ShippingLabelEstimatePackage[] = packagesOf(shipment).map((pkg) => {
    const rate = rateOf(getField(pkg, "EstimatedRate"), ESTIMATED_KEYS);
    const parsed: ShippingLabelEstimatePackage = {
      succeeded: succeededOf(pkg, rate !== undefined),
      signatureRequired:
        asString(getField(pkg, "SignatureOptions"))?.trim().toLowerCase() ===
        SIGNATURE_REGULAR.toLowerCase(),
    };
    const errorMessage = nonEmpty(asString(getField(pkg, "ErrorMessage")));
    if (errorMessage !== undefined) parsed.errorMessage = errorMessage;
    const weight = asNumber(getField(pkg, "PackageWeight"));
    if (weight !== undefined) parsed.weightLb = weight;
    const length = asNumber(getField(pkg, "PackageLength"));
    if (length !== undefined) parsed.lengthIn = length;
    const width = asNumber(getField(pkg, "PackageWidth"));
    if (width !== undefined) parsed.widthIn = width;
    const height = asNumber(getField(pkg, "PackageHeight"));
    if (height !== undefined) parsed.heightIn = height;
    if (rate !== undefined) parsed.rate = rate;
    return parsed;
  });
  const out: ParsedEstimateLabel = {
    orderNumber: asString(getField(shipment, "OrderNumber")) ?? "",
    packages,
    estimatedTotal: packages.reduce(
      (sum, pkg) => (pkg.succeeded ? sum + (pkg.rate?.total ?? 0) : sum),
      0,
    ),
  };
  const estimatedDate = toTimestamp(asString(getField(shipment, "EstimatedDate")));
  if (estimatedDate !== undefined) out.estimatedDate = estimatedDate;
  return out;
}
