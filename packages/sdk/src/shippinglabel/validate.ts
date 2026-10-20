/**
 * Input validation for the Shipping Label Service (contracts §23). Zod 4 strict schemas check
 * shape and ranges; the carrier limits the pages state (UPS weight / length / length-plus-girth,
 * errors SL007 to SL009) and the per-marketplace service codes, country and postal code are
 * applied on top. Every function returns the NORMALIZED input (order number as a digit string,
 * country defaulted, no unknown keys) or throws one {@link NeweggValidationError} listing every
 * issue. Nothing is rounded or clamped.
 */
import { z } from "zod";
import type { ShippingLabelInput, ShippingLabelReprintInput } from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import type { ShippingLabelPlatform } from "../platform/shipping-label.js";
import {
  MAX_ORDER_NUMBER,
  SHIPPING_LABEL_MAX_ITEMS_PER_PACKAGE,
  SHIPPING_LABEL_MAX_PACKAGES,
  UPS_MAX_LENGTH_IN,
  UPS_MAX_LENGTH_PLUS_GIRTH_IN,
  UPS_MAX_WEIGHT_LB,
} from "./constants.js";

const orderNumberSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(
    z
      .string()
      .regex(/^[1-9]\d{0,9}$/, "must be a positive integer")
      .refine((value) => Number(value) <= MAX_ORDER_NUMBER, `must be <= ${MAX_ORDER_NUMBER}`),
  );

const text = (max: number) => z.string().trim().min(1).max(max);

const dimensionSchema = z.number().gt(0, "must be > 0");

const itemSchema = z.strictObject({
  sellerPartNumber: text(40),
  quantity: z.number().int().min(1).max(99999),
});

const packageSchema = z.strictObject({
  weightLb: dimensionSchema.max(UPS_MAX_WEIGHT_LB, `must be <= ${UPS_MAX_WEIGHT_LB} lb (UPS)`),
  lengthIn: dimensionSchema.max(UPS_MAX_LENGTH_IN, `must be <= ${UPS_MAX_LENGTH_IN} in (UPS)`),
  widthIn: dimensionSchema,
  heightIn: dimensionSchema,
  signatureRequired: z.boolean().optional(),
  items: z.array(itemSchema).min(1).max(SHIPPING_LABEL_MAX_ITEMS_PER_PACKAGE),
});

const shipFromSchema = z.strictObject({
  firstName: text(50),
  lastName: text(50),
  phoneNumber: z
    .string()
    .trim()
    .regex(/^[0-9+()\-. ]{7,25}$/, "must be a phone number (digits, spaces and + ( ) - .)"),
  address1: text(100),
  address2: text(100).optional(),
  city: text(60),
  stateCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "must be a two-letter state or province code")
    .transform((value) => value.toUpperCase()),
  zipCode: text(10),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "must be an ISO alpha-3 country code")
    .transform((value) => value.toUpperCase())
    .optional(),
});

const inputSchema = z.strictObject({
  orderNumber: orderNumberSchema,
  serviceCode: z.number().int().optional(),
  shipFrom: shipFromSchema,
  packages: z.array(packageSchema).min(1).max(SHIPPING_LABEL_MAX_PACKAGES),
});

const reprintSchema = z.strictObject({ orderNumber: orderNumberSchema });

function pathOf(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".") || "input";
}

function fail(label: string, issues: NeweggValidationIssue[]): never {
  throw new NeweggValidationError(`${label} is invalid.`, issues);
}

function zodIssues(error: z.ZodError): NeweggValidationIssue[] {
  return error.issues.map((issue) => ({ path: pathOf(issue.path), message: issue.message }));
}

/** Validates and normalizes a label request for this marketplace. */
export function normalizeShippingLabelInput(
  input: ShippingLabelInput,
  platform: ShippingLabelPlatform,
): ShippingLabelInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return fail("The shipping label request", zodIssues(parsed.error));
  const value = parsed.data;
  const issues: NeweggValidationIssue[] = [];

  if (value.serviceCode !== undefined && !platform.serviceCodes.includes(value.serviceCode)) {
    issues.push({
      path: "serviceCode",
      message: `${value.serviceCode} is not a documented UPS service code on ${platform.marketplace}; use one of ${platform.serviceCodes.join(", ")}.`,
    });
  }
  const country = value.shipFrom.countryCode ?? platform.countryCode;
  if (country !== platform.countryCode) {
    issues.push({
      path: "shipFrom.countryCode",
      message: `must be ${platform.countryCode} on ${platform.marketplace}`,
    });
  }
  if (!platform.postalCodePattern.test(value.shipFrom.zipCode)) {
    issues.push({
      path: "shipFrom.zipCode",
      message: `must be ${platform.postalCodeHint}`,
    });
  }
  value.packages.forEach((pkg, index) => {
    const lengthPlusGirth = pkg.lengthIn + 2 * pkg.widthIn + 2 * pkg.heightIn;
    if (lengthPlusGirth > UPS_MAX_LENGTH_PLUS_GIRTH_IN) {
      issues.push({
        path: `packages.${index}`,
        message: `length + 2 x width + 2 x height is ${lengthPlusGirth} in, over the UPS limit of ${UPS_MAX_LENGTH_PLUS_GIRTH_IN} in`,
      });
    }
  });
  if (issues.length > 0) return fail("The shipping label request", issues);

  const normalized: ShippingLabelInput = {
    orderNumber: value.orderNumber,
    shipFrom: {
      firstName: value.shipFrom.firstName,
      lastName: value.shipFrom.lastName,
      phoneNumber: value.shipFrom.phoneNumber,
      address1: value.shipFrom.address1,
      city: value.shipFrom.city,
      stateCode: value.shipFrom.stateCode,
      zipCode: value.shipFrom.zipCode,
      countryCode: country,
    },
    packages: value.packages.map((pkg) => ({
      weightLb: pkg.weightLb,
      lengthIn: pkg.lengthIn,
      widthIn: pkg.widthIn,
      heightIn: pkg.heightIn,
      ...(pkg.signatureRequired === true ? { signatureRequired: true } : {}),
      items: pkg.items.map((item) => ({
        sellerPartNumber: item.sellerPartNumber,
        quantity: item.quantity,
      })),
    })),
  };
  if (value.shipFrom.address2 !== undefined) normalized.shipFrom.address2 = value.shipFrom.address2;
  if (value.serviceCode !== undefined) normalized.serviceCode = value.serviceCode;
  return normalized;
}

/** Validates a reprint request. */
export function normalizeReprintInput(orderNumber: string | number): ShippingLabelReprintInput {
  const parsed = reprintSchema.safeParse({ orderNumber });
  if (!parsed.success) return fail("The shipping label reprint request", zodIssues(parsed.error));
  return { orderNumber: parsed.data.orderNumber };
}
