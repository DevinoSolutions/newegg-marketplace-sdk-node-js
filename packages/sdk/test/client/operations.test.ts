import { describe, expect, it } from "vitest";
import { isReadOperation, Operation } from "../../src/client/operations.js";

describe("isReadOperation", () => {
  it("classifies reads and writes by what they do, not by verb", () => {
    expect(isReadOperation(Operation.OrderList)).toBe(true);
    expect(isReadOperation(Operation.ReportSubmit)).toBe(true);
    expect(isReadOperation(Operation.UpdateDirect)).toBe(false);
    expect(isReadOperation(Operation.OrderShip)).toBe(false);
    expect(isReadOperation(Operation.ShippingLabelEstimate)).toBe(false);
  });

  it("fails closed for an unknown operation", () => {
    expect(isReadOperation("nope.unknown")).toBe(false);
    expect(isReadOperation("")).toBe(false);
  });

  it("gives every operation a unique identifier", () => {
    const values = Object.values(Operation);
    expect(new Set(values).size).toBe(values.length);
  });
});
