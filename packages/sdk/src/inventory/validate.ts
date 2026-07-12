import type { z } from "zod";
import type {
  GetItemInput,
  GetManyInput,
  InventoryUpdate,
  NeweggMarketplace,
  NormalizedInventoryUpdate,
} from "../types.js";
import { NeweggValidationError, type NeweggValidationIssue } from "../errors/index.js";
import {
  getItemInputSchema,
  getManyInputSchema,
  inventoryUpdateSchema,
} from "../schemas/inputs.js";

function zodIssues(error: z.ZodError, inputIndex?: number): NeweggValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    ...(inputIndex === undefined ? {} : { inputIndex }),
  }));
}

/** Runs a schema and throws {@link NeweggValidationError} with sanitized issues on failure. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new NeweggValidationError(message, zodIssues(result.error));
  }
  return result.data;
}

interface UpdateValidationContext {
  marketplace: NeweggMarketplace;
  maxQuantity?: number;
}

/**
 * Validates a list of inventory updates (schema + app policies) and returns them normalized
 * with their original input index. Throws {@link NeweggValidationError} listing every issue,
 * each with a path and the offending `inputIndex`.
 */
export function validateInventoryUpdates(
  updates: InventoryUpdate[],
  ctx: UpdateValidationContext,
): NormalizedInventoryUpdate[] {
  const requireWarehouse = ctx.marketplace === "us";
  const issues: NeweggValidationIssue[] = [];
  const normalized: NormalizedInventoryUpdate[] = [];

  updates.forEach((update, inputIndex) => {
    const result = inventoryUpdateSchema.safeParse(update);
    if (!result.success) {
      issues.push(...zodIssues(result.error, inputIndex));
      return;
    }
    const value = result.data;
    if (ctx.maxQuantity !== undefined && value.quantity > ctx.maxQuantity) {
      issues.push({
        path: "quantity",
        message: `quantity ${value.quantity} exceeds configured maxQuantity ${ctx.maxQuantity}`,
        inputIndex,
      });
    }
    if (requireWarehouse && value.warehouseLocation === undefined) {
      issues.push({
        path: "warehouseLocation",
        message: "warehouseLocation is required for US inventory operations",
        inputIndex,
      });
    }
    normalized.push({ ...value, inputIndex });
  });

  if (issues.length > 0) {
    throw new NeweggValidationError("Inventory update validation failed.", issues);
  }
  return normalized;
}

/** Throws {@link NeweggValidationError} if any update lacks a `sellerPartNumber` identifier. */
export function requireSellerPartNumbers(updates: NormalizedInventoryUpdate[]): void {
  const issues: NeweggValidationIssue[] = updates
    .filter((update) => update.identifier.type !== "sellerPartNumber")
    .map((update) => ({
      path: "identifier.type",
      message: "feed submission requires a sellerPartNumber identifier",
      inputIndex: update.inputIndex,
    }));
  if (issues.length > 0) {
    throw new NeweggValidationError(
      "Feed submission requires sellerPartNumber identifiers.",
      issues,
    );
  }
}

export function validateGetItemInput(input: GetItemInput): GetItemInput {
  return parseOrThrow(getItemInputSchema, input, "getItem input validation failed.");
}

export function validateGetManyInput(input: GetManyInput): GetManyInput {
  return parseOrThrow(getManyInputSchema, input, "getMany input validation failed.");
}
