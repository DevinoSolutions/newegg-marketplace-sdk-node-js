import { describe, expect, it } from "vitest";
import {
  asArray,
  asBoolean,
  asNumber,
  asString,
  asStringRecord,
  getField,
  getPath,
} from "../src/schemas/wire.js";

/**
 * Direct unit tests for the tolerant wire readers. These helpers guard EVERY upstream parse,
 * and Newegg's XML→JSON conversion is hostile: scalars arrive as strings or numbers, booleans
 * as "0"/"1"/"true", and any list is a single object OR an array interchangeably. The cases
 * below pin that coercion contract — and its boundaries (falsy-but-valid 0/"0", non-finite
 * numbers, non-object inputs) — so a regression in defensive parsing fails here.
 */

describe("asArray — object-or-array normalization", () => {
  it("wraps a single object as a one-element array", () => {
    const single = { WarehouseCode: "07", Quantity: "3" };
    expect(asArray(single)).toEqual([single]);
  });

  it("returns an existing array unchanged", () => {
    const list = [{ a: 1 }, { a: 2 }];
    expect(asArray(list)).toBe(list); // same reference, not re-wrapped
    expect(asArray(list)).toHaveLength(2);
  });

  it("maps undefined and null to an empty array (missing list is not an error)", () => {
    expect(asArray(undefined)).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });

  it("wraps scalars too, including falsy ones", () => {
    expect(asArray("A006BSP3")).toEqual(["A006BSP3"]);
    expect(asArray(0)).toEqual([0]);
    expect(asArray(false)).toEqual([false]);
  });
});

describe("asString", () => {
  it("passes strings through and stringifies finite numbers and booleans", () => {
    expect(asString("abc")).toBe("abc");
    expect(asString(42)).toBe("42");
    expect(asString(0)).toBe("0"); // falsy but valid — must not become undefined
    expect(asString(true)).toBe("true");
    expect(asString(false)).toBe("false");
  });

  it("rejects non-finite numbers and non-scalars", () => {
    expect(asString(Number.NaN)).toBeUndefined();
    expect(asString(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString({})).toBeUndefined();
    expect(asString([1])).toBeUndefined();
  });
});

describe("asNumber — Newegg sends quantities as strings", () => {
  it("coerces numeric strings, tolerating surrounding whitespace", () => {
    expect(asNumber("107")).toBe(107); // §5.1 AvailableQuantity arrives as a string
    expect(asNumber(" 40 ")).toBe(40);
    expect(asNumber("3.5")).toBe(3.5);
    expect(asNumber("0")).toBe(0); // falsy but valid
  });

  it("passes finite numbers through", () => {
    expect(asNumber(71)).toBe(71);
    expect(asNumber(0)).toBe(0);
  });

  it("returns undefined for empty, non-numeric, non-finite, or wrong-typed input", () => {
    expect(asNumber("")).toBeUndefined();
    expect(asNumber("   ")).toBeUndefined();
    expect(asNumber("abc")).toBeUndefined();
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asNumber(true)).toBeUndefined(); // booleans are NOT coerced to 1/0 here
    expect(asNumber(null)).toBeUndefined();
    expect(asNumber(undefined)).toBeUndefined();
  });
});

describe("asBoolean — Newegg encodes booleans as 0/1/true/no", () => {
  it("reads native booleans", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
  });

  it("reads the numeric 1/0 encoding but rejects other numbers", () => {
    expect(asBoolean(1)).toBe(true);
    expect(asBoolean(0)).toBe(false);
    expect(asBoolean(2)).toBeUndefined();
  });

  it("reads string encodings case-insensitively", () => {
    expect(asBoolean("1")).toBe(true); // Active:"1"
    expect(asBoolean("0")).toBe(false); // Active:"0" (§5.2 sample)
    expect(asBoolean("true")).toBe(true);
    expect(asBoolean("TRUE")).toBe(true);
    expect(asBoolean("yes")).toBe(true);
    expect(asBoolean("false")).toBe(false);
    expect(asBoolean("no")).toBe(false);
  });

  it("returns undefined for ambiguous or wrong-typed input", () => {
    expect(asBoolean("maybe")).toBeUndefined();
    expect(asBoolean("")).toBeUndefined();
    expect(asBoolean(null)).toBeUndefined();
    expect(asBoolean(undefined)).toBeUndefined();
    expect(asBoolean({})).toBeUndefined();
  });
});

describe("getField — tolerant single-key read", () => {
  it("reads a present key from a record", () => {
    expect(getField({ SellerID: "A006" }, "SellerID")).toBe("A006");
  });

  it("returns undefined for a missing key or a non-record container", () => {
    expect(getField({ a: 1 }, "b")).toBeUndefined();
    expect(getField(null, "a")).toBeUndefined();
    expect(getField(undefined, "a")).toBeUndefined();
    expect(getField("A006", "length")).toBeUndefined(); // strings are not records
    expect(getField([{ a: 1 }], "0")).toBeUndefined(); // arrays are not records
  });
});

describe("getPath — nested envelope navigation", () => {
  it("walks a nested Newegg envelope to the target list", () => {
    // The US read nests the inventory list two levels deep.
    const body = { InventoryAllocation: { Inventory: [{ AvailableQuantity: "107" }] } };
    expect(getPath(body, ["InventoryAllocation", "Inventory"])).toEqual([
      { AvailableQuantity: "107" },
    ]);
    expect(getPath(body, ["InventoryAllocation", "Inventory", "0", "AvailableQuantity"])).toBe(
      // index "0" is a string key into an array — arrays are not records, so this stops short
      undefined,
    );
  });

  it("returns the input unchanged for an empty path", () => {
    const value = { a: 1 };
    expect(getPath(value, [])).toBe(value);
  });

  it("returns undefined when any intermediate is missing or non-object", () => {
    expect(getPath({ a: { b: { c: 5 } } }, ["a", "b", "c"])).toBe(5);
    expect(getPath({ a: { b: { c: 5 } } }, ["a", "x", "c"])).toBeUndefined();
    expect(getPath({ a: 1 }, ["a", "b"])).toBeUndefined(); // intermediate is a scalar
    expect(getPath(null, ["a"])).toBeUndefined();
  });
});

describe("asStringRecord", () => {
  it("coerces scalar fields to strings and drops nested objects/arrays", () => {
    const record = {
      SellerPartNumber: "A006BSP3",
      AvailableQuantity: 71,
      Active: true,
      WarehouseAllocation: { Warehouse: [] }, // dropped — not a scalar
      tags: ["x"], // dropped — not a scalar
    };
    expect(asStringRecord(record)).toEqual({
      SellerPartNumber: "A006BSP3",
      AvailableQuantity: "71",
      Active: "true",
    });
  });

  it("returns an empty object for non-record input", () => {
    expect(asStringRecord(null)).toEqual({});
    expect(asStringRecord("nope")).toEqual({});
    expect(asStringRecord([1, 2])).toEqual({});
  });
});
