/**
 * Input validation for the RMA and courtesy-refund WRITES (contracts §20). Zod 4 strict schemas
 * check shape, ranges and money (positive, at most two decimals, never rounded or clamped); the
 * cross-field rules the pages state (refund-only prices, evidence for reasons 3 / 4 / 6 / 8, the
 * per-marketplace evidence and reject-reason sets) are applied on top, per marketplace, from
 * `platform/rma.ts`. Every function returns the NORMALIZED input (order and RMA numbers as digit
 * strings, no unknown keys) or throws one {@link NeweggValidationError} listing every issue.
 */
import { z } from "zod";
import type {
  EditRmaInput,
  IssueCourtesyRefundInput,
  ProcessRmaInput,
  RejectRmaInput,
  RmaWriteItem,
  SubmitRmaInput,
} from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import type { RmaPlatform } from "../platform/rma.js";
import {
  REJECT_EVIDENCE_CODES,
  RMA_EVIDENCE_REASONS,
  RMA_WRITE_MAX_ITEMS,
  SERVICE_WRITE_MAX_AMOUNT,
} from "./write-constants.js";

const twoDecimals = (value: number): boolean =>
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

const digitsSchema = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().regex(/^[1-9]\d{0,14}$/, `${label} must be a positive integer`));

/** A refund amount per unit / a courtesy refund: > 0, at most 2 decimals. */
const positiveAmountSchema = z
  .number()
  .gt(0, "must be > 0")
  .max(SERVICE_WRITE_MAX_AMOUNT, `must be <= ${SERVICE_WRITE_MAX_AMOUNT}`)
  .refine(twoDecimals, "must have at most 2 decimal places");

/** A shipping refund: >= 0, at most 2 decimals. */
const nonNegativeAmountSchema = z
  .number()
  .min(0, "must be >= 0")
  .max(SERVICE_WRITE_MAX_AMOUNT, `must be <= ${SERVICE_WRITE_MAX_AMOUNT}`)
  .refine(twoDecimals, "must have at most 2 decimal places");

const imageUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

const imageUrlsSchema = z.array(imageUrlSchema).min(1).max(5);

const rmaTypeSchema = z.enum(["refund", "replacement"]);

const writeReasonSchema = z.enum([
  "itemDamaged",
  "defective",
  "incompatible",
  "noLongerNeeded",
  "notAsDescribed",
  "orderedWrongItem",
  "sentWrongItem",
  "unsatisfied",
  "extraItemShipped",
  "itemNotReceived",
]);

const itemSchema = z.strictObject({
  sellerPartNumber: z.string().trim().min(1).max(40),
  returnQuantity: z.number().int().min(1).max(99999),
  reason: writeReasonSchema,
  returnUnitPrice: positiveAmountSchema.optional(),
  refundShippingPrice: nonNegativeAmountSchema.optional(),
  unopened: z.boolean().optional(),
  imageUrls: imageUrlsSchema.optional(),
  memo: z.string().trim().min(1).max(1000).optional(),
});

const sellerRmaNumberSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{1,50}$/, "must be 1-50 letters and digits only");

const noteSchema = z.string().trim().min(1).max(4000);

const submitSchema = z.strictObject({
  orderNumber: digitsSchema("orderNumber"),
  type: rmaTypeSchema,
  items: z.array(itemSchema).min(1).max(RMA_WRITE_MAX_ITEMS),
  sellerRmaNumber: sellerRmaNumberSchema.optional(),
  note: noteSchema.optional(),
  autoReceive: z.boolean().optional(),
});

const editSchema = z.strictObject({
  rmaNumber: digitsSchema("rmaNumber"),
  type: rmaTypeSchema,
  note: noteSchema,
  items: z.array(itemSchema).min(1).max(RMA_WRITE_MAX_ITEMS),
  sellerRmaNumber: sellerRmaNumberSchema.optional(),
});

const processSchema = z.strictObject({ rmaNumber: digitsSchema("rmaNumber") });

const rejectSchema = z.strictObject({
  rmaNumber: digitsSchema("rmaNumber"),
  reason: z.enum([
    "physicalDamage",
    "itemMissing",
    "wrongItemReturned",
    "cpuPinDamage",
    "missingRetailBox",
    "missingUpcCode",
    "tamperedSerialNumber",
    "missingAccessories",
    "consumableItem",
    "motherboardSocketPinDamage",
    "qaSentWrongItem",
    "unlockedCellphone",
    "usedItemReturnedAsNew",
    "customerRequest",
    "missingSerialNumber",
    "software",
  ]),
  carrier: z.enum(["ups", "fedex", "dhl", "usps", "other"]),
  otherCarrier: z.string().trim().min(1).max(10).optional(),
  shipService: z.string().trim().min(1).max(50),
  trackingNumbers: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  memo: z.string().trim().min(1).max(1000).optional(),
  imageUrls: imageUrlsSchema.optional(),
});

const courtesyRefundSchema = z.strictObject({
  orderNumber: digitsSchema("orderNumber"),
  reason: z.enum([
    "negativeCustomerFeedback",
    "pricingError",
    "wrongItemInformation",
    "shippingDelay",
    "packageNotReceived",
    "customerCourtesy",
  ]),
  amount: positiveAmountSchema,
  noteToCustomer: z.string().trim().min(1).max(500).optional(),
});

/** Runs a schema and converts zod issues into one {@link NeweggValidationError}. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown, message: string): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new NeweggValidationError(
      message,
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function throwIfAny(message: string, issues: NeweggValidationIssue[]): void {
  if (issues.length > 0) throw new NeweggValidationError(message, issues);
}

/** Cross-field rules for the lines of a submitted or edited RMA. */
function checkItems(
  items: readonly RmaWriteItem[],
  type: "refund" | "replacement",
  platform: RmaPlatform,
  issues: NeweggValidationIssue[],
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const at = (field: string): string => `items.${index}.${field}`;
    if (seen.has(item.sellerPartNumber)) {
      issues.push({
        path: at("sellerPartNumber"),
        message: "appears on more than one line; merge the quantities into a single line",
      });
    }
    seen.add(item.sellerPartNumber);

    if (type === "refund") {
      if (item.returnUnitPrice === undefined) {
        issues.push({ path: at("returnUnitPrice"), message: "is required for a refund RMA" });
      }
      if (item.refundShippingPrice === undefined) {
        issues.push({
          path: at("refundShippingPrice"),
          message: "is required for a refund RMA (use 0 for no shipping refund)",
        });
      }
    } else {
      for (const field of ["returnUnitPrice", "refundShippingPrice"] as const) {
        if (item[field] !== undefined) {
          issues.push({ path: at(field), message: "is only allowed on a refund RMA" });
        }
      }
    }

    const evidenceRequired = RMA_EVIDENCE_REASONS.has(item.reason);
    if (evidenceRequired && item.unopened === undefined) {
      issues.push({
        path: at("unopened"),
        message: `is required when the reason is ${item.reason}`,
      });
    }
    if (platform.acceptsEvidenceFiles) {
      if (evidenceRequired && item.imageUrls === undefined) {
        issues.push({
          path: at("imageUrls"),
          message: `1-5 image URLs are required when the reason is ${item.reason}`,
        });
      }
      if (evidenceRequired && item.memo === undefined) {
        issues.push({
          path: at("memo"),
          message: `is required when the reason is ${item.reason}`,
        });
      }
    } else {
      for (const field of ["imageUrls", "memo"] as const) {
        if (item[field] !== undefined) {
          issues.push({
            path: at(field),
            message: `is not accepted on the ${platform.marketplace} marketplace (documented US and CAN only)`,
          });
        }
      }
    }
  });
}

/** Validates and normalizes a Submit RMA input. */
export function normalizeSubmitRma(input: unknown, platform: RmaPlatform): SubmitRmaInput {
  const value = parseInput(submitSchema, input, "Invalid Submit RMA input.");
  const issues: NeweggValidationIssue[] = [];
  checkItems(value.items, value.type, platform, issues);
  if (value.autoReceive === true && value.type !== "refund") {
    issues.push({ path: "autoReceive", message: "is only allowed on a refund RMA" });
  }
  throwIfAny("Invalid Submit RMA input.", issues);
  return value;
}

/** Validates and normalizes an Edit RMA input. */
export function normalizeEditRma(input: unknown, platform: RmaPlatform): EditRmaInput {
  const value = parseInput(editSchema, input, "Invalid Edit RMA input.");
  const issues: NeweggValidationIssue[] = [];
  checkItems(value.items, value.type, platform, issues);
  throwIfAny("Invalid Edit RMA input.", issues);
  return value;
}

/** Validates and normalizes a Process (receive) RMA input. */
export function normalizeProcessRma(input: unknown): ProcessRmaInput {
  return parseInput(processSchema, input, "Invalid Process RMA input.");
}

/** Validates and normalizes a Reject RMA input against the marketplace's reject-reason set. */
export function normalizeRejectRma(input: unknown, platform: RmaPlatform): RejectRmaInput {
  const value = parseInput(rejectSchema, input, "Invalid Reject RMA input.");
  const issues: NeweggValidationIssue[] = [];
  const code = platform.rejectReasonCodes[value.reason];
  if (code === undefined) {
    issues.push({
      path: "reason",
      message: `${value.reason} is not available on the ${platform.marketplace} marketplace`,
    });
  } else if (REJECT_EVIDENCE_CODES.has(code)) {
    if (value.memo === undefined) {
      issues.push({ path: "memo", message: `is required when the reason is ${value.reason}` });
    }
    if (value.imageUrls === undefined) {
      issues.push({
        path: "imageUrls",
        message: `1-5 image URLs are required when the reason is ${value.reason}`,
      });
    }
  }
  if (value.carrier === "other" && value.otherCarrier === undefined) {
    issues.push({ path: "otherCarrier", message: 'is required when the carrier is "other"' });
  }
  if (value.carrier !== "other" && value.otherCarrier !== undefined) {
    issues.push({ path: "otherCarrier", message: 'is only allowed when the carrier is "other"' });
  }
  throwIfAny("Invalid Reject RMA input.", issues);
  return value;
}

/** Validates and normalizes an Issue Courtesy Refund input. */
export function normalizeCourtesyRefund(input: unknown): IssueCourtesyRefundInput {
  return parseInput(courtesyRefundSchema, input, "Invalid Issue Courtesy Refund input.");
}
