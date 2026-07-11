import { describe, expect, it } from "vitest";
import { NeweggValidationError } from "../src/index.js";
import type { InventoryUpdate } from "../src/index.js";
import { makeClient } from "./helpers.js";

const WAREHOUSE = { warehouseLocation: "USA" };

async function expectValidationError(fn: () => Promise<unknown>): Promise<NeweggValidationError> {
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(NeweggValidationError);
  return error as NeweggValidationError;
}

describe("input validation", () => {
  it("rejects a negative quantity", async () => {
    const { client } = makeClient("us", []);
    const error = await expectValidationError(() =>
      client.inventory.previewUpdate({
        identifier: { type: "sellerPartNumber", value: "sku" },
        quantity: -1,
        ...WAREHOUSE,
      }),
    );
    expect(error.issues.some((issue) => issue.path === "quantity")).toBe(true);
  });

  it("rejects a fractional quantity", async () => {
    const { client } = makeClient("us", []);
    await expectValidationError(() =>
      client.inventory.previewUpdate({
        identifier: { type: "sellerPartNumber", value: "sku" },
        quantity: 1.5,
        ...WAREHOUSE,
      }),
    );
  });

  it("accepts a quantity of 0 as meaningful", async () => {
    const { client } = makeClient("us", []);
    const preview = await client.inventory.previewUpdate({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 0,
      ...WAREHOUSE,
    });
    expect(preview.zeroQuantityCount).toBe(1);
    expect(preview.normalizedUpdates).toHaveLength(1);
  });

  it("requires a warehouse for US operations", async () => {
    const { client } = makeClient("us", []);
    const error = await expectValidationError(() =>
      client.inventory.previewUpdate({
        identifier: { type: "sellerPartNumber", value: "sku" },
        quantity: 5,
      }),
    );
    expect(error.issues.some((issue) => issue.path === "warehouseLocation")).toBe(true);
  });

  it("does not require a warehouse for B2B/CA operations", async () => {
    const { client } = makeClient("ca", []);
    const preview = await client.inventory.previewUpdate({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 5,
    });
    expect(preview.normalizedUpdates).toHaveLength(1);
  });

  it("rejects a bad ISO warehouse code", async () => {
    const { client } = makeClient("us", []);
    for (const warehouseLocation of ["USAX", "us"]) {
      await expectValidationError(() =>
        client.inventory.previewUpdate({
          identifier: { type: "sellerPartNumber", value: "sku" },
          quantity: 5,
          warehouseLocation,
        }),
      );
    }
  });

  it("rejects unknown fields (strict schema)", async () => {
    const { client } = makeClient("ca", []);
    await expectValidationError(() =>
      client.inventory.previewUpdate({
        identifier: { type: "sellerPartNumber", value: "sku" },
        quantity: 5,
        surprise: true,
      } as unknown as InventoryUpdate),
    );
  });

  it("rejects an invalid identifier type", async () => {
    const { client } = makeClient("ca", []);
    await expectValidationError(() =>
      client.inventory.previewUpdate({
        identifier: { type: "ean", value: "x" },
        quantity: 5,
      } as unknown as InventoryUpdate),
    );
  });

  it("rejects a condition key on a non-UPC identifier", async () => {
    const { client } = makeClient("ca", []);
    await expectValidationError(() =>
      client.inventory.previewUpdate({
        identifier: { type: "sellerPartNumber", value: "sku", condition: "new" },
        quantity: 5,
      } as unknown as InventoryUpdate),
    );
  });

  it("rejects a seller part number longer than 40 characters", async () => {
    const { client } = makeClient("ca", []);
    await expectValidationError(() =>
      client.inventory.previewUpdate({
        identifier: { type: "sellerPartNumber", value: "x".repeat(41) },
        quantity: 5,
      }),
    );
  });

  it("enforces the configured maxQuantity ceiling without silent clamping", async () => {
    const { client } = makeClient("ca", [], { maxQuantity: 500 });
    const ok = await client.inventory.previewUpdate({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 500,
    });
    expect(ok.normalizedUpdates[0]!.quantity).toBe(500);

    const error = await expectValidationError(() =>
      client.inventory.previewUpdate({
        identifier: { type: "sellerPartNumber", value: "sku" },
        quantity: 501,
      }),
    );
    expect(error.issues.some((issue) => issue.message.includes("maxQuantity"))).toBe(true);
  });

  it("attaches inputIndex to each issue in a batch", async () => {
    const { client } = makeClient("us", []);
    const error = await expectValidationError(() =>
      client.inventory.updateMany([
        {
          identifier: { type: "sellerPartNumber", value: "ok" },
          quantity: 1,
          warehouseLocation: "USA",
        },
        {
          identifier: { type: "sellerPartNumber", value: "bad" },
          quantity: -1,
          warehouseLocation: "USA",
        },
      ]),
    );
    expect(error.issues.every((issue) => typeof issue.inputIndex === "number")).toBe(true);
    expect(error.issues.some((issue) => issue.inputIndex === 1)).toBe(true);
  });
});
