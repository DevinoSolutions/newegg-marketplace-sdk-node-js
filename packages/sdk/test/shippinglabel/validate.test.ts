import { describe, expect, it } from "vitest";
import { NeweggValidationError } from "../../src/errors/index.js";
import { getShippingLabelPlatform } from "../../src/platform/shipping-label.js";
import {
  normalizeReprintInput,
  normalizeShippingLabelInput,
} from "../../src/shippinglabel/validate.js";
import {
  SHIPPING_LABEL_MAX_ITEMS_PER_PACKAGE,
  SHIPPING_LABEL_MAX_PACKAGES,
} from "../../src/shippinglabel/constants.js";
import type { ShippingLabelInput } from "../../src/types.js";

const US = getShippingLabelPlatform("us");
const CA = getShippingLabelPlatform("ca");

const pkg = (): ShippingLabelInput["packages"][number] => ({
  weightLb: 3.5,
  lengthIn: 12,
  widthIn: 8,
  heightIn: 4,
  items: [{ sellerPartNumber: "SKU-1", quantity: 2 }],
});

const base = (): ShippingLabelInput => ({
  orderNumber: "900000001",
  shipFrom: {
    firstName: "Test",
    lastName: "Sender",
    phoneNumber: "555 0100",
    address1: "1 Placeholder Way",
    city: "Testville",
    stateCode: "ca",
    zipCode: "90001",
  },
  packages: [pkg()],
});

function issues(input: unknown, platform = US): Array<{ path: string; message: string }> {
  try {
    normalizeShippingLabelInput(input as ShippingLabelInput, platform);
  } catch (err) {
    expect(err).toBeInstanceOf(NeweggValidationError);
    return (err as NeweggValidationError).issues;
  }
  throw new Error("expected a validation error");
}

describe("normalizeShippingLabelInput: normalization", () => {
  it("uppercases the state, defaults the country and keeps optional fields out when absent", () => {
    const out = normalizeShippingLabelInput(base(), US);
    expect(out.shipFrom.stateCode).toBe("CA");
    expect(out.shipFrom.countryCode).toBe("USA");
    expect(out.shipFrom).not.toHaveProperty("address2");
    expect(out).not.toHaveProperty("serviceCode");
    expect(out.packages[0]).not.toHaveProperty("signatureRequired");
  });

  it("stringifies and trims the order number (a number input works)", () => {
    expect(
      normalizeShippingLabelInput({ ...base(), orderNumber: 123 as never }, US).orderNumber,
    ).toBe("123");
    expect(normalizeShippingLabelInput({ ...base(), orderNumber: " 456 " }, US).orderNumber).toBe(
      "456",
    );
  });

  it("trims text fields and keeps address2, serviceCode and signatureRequired: true", () => {
    const input = base();
    input.shipFrom.firstName = "  Test  ";
    input.shipFrom.address2 = " Suite 2 ";
    input.serviceCode = 103;
    input.packages = [{ ...pkg(), signatureRequired: true }];
    const out = normalizeShippingLabelInput(input, US);
    expect(out.shipFrom.firstName).toBe("Test");
    expect(out.shipFrom.address2).toBe("Suite 2");
    expect(out.serviceCode).toBe(103);
    expect(out.packages[0]?.signatureRequired).toBe(true);
  });

  it("drops signatureRequired: false rather than sending it", () => {
    const input = base();
    input.packages = [{ ...pkg(), signatureRequired: false }];
    expect(normalizeShippingLabelInput(input, US).packages[0]).not.toHaveProperty(
      "signatureRequired",
    );
  });

  it("does not mutate the caller's input", () => {
    const input = base();
    const snapshot = JSON.stringify(input);
    normalizeShippingLabelInput(input, US);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("accepts an explicit lower-case country matching the marketplace", () => {
    const input = base();
    input.shipFrom.countryCode = "usa";
    expect(normalizeShippingLabelInput(input, US).shipFrom.countryCode).toBe("USA");
  });

  it("defaults the country to CAN on Newegg.ca and accepts Canadian postal codes", () => {
    for (const zipCode of ["K1A 0B1", "k1a0b1", "K1A-0B1"]) {
      const input = base();
      input.shipFrom.zipCode = zipCode;
      input.serviceCode = 111;
      expect(normalizeShippingLabelInput(input, CA).shipFrom.countryCode).toBe("CAN");
    }
  });
});

describe("normalizeShippingLabelInput: rejections", () => {
  it("rejects unknown keys at every level (strict objects)", () => {
    expect(issues({ ...base(), extra: 1 }).length).toBeGreaterThan(0);
    const nested = base();
    (nested.shipFrom as unknown as Record<string, unknown>).nickname = "x";
    expect(issues(nested).length).toBeGreaterThan(0);
    const inPackage = base();
    (inPackage.packages[0] as unknown as Record<string, unknown>).fragile = true;
    expect(issues(inPackage).length).toBeGreaterThan(0);
  });

  it.each(["0", "01", "-5", "1.5", "", "12A", "2147483648", "99999999999"])(
    "rejects order number %j",
    (orderNumber) => {
      expect(issues({ ...base(), orderNumber }).map((i) => i.path)).toContain("orderNumber");
    },
  );

  it("accepts the boundary order numbers 1 and 2147483647", () => {
    expect(normalizeShippingLabelInput({ ...base(), orderNumber: "1" }, US).orderNumber).toBe("1");
    expect(
      normalizeShippingLabelInput({ ...base(), orderNumber: "2147483647" }, US).orderNumber,
    ).toBe("2147483647");
  });

  it("enforces the UPS weight, length and length-plus-girth boundaries exactly", () => {
    const at = (p: Partial<ShippingLabelInput["packages"][number]>): ShippingLabelInput => ({
      ...base(),
      packages: [{ ...pkg(), ...p }],
    });
    expect(() => normalizeShippingLabelInput(at({ weightLb: 150 }), US)).not.toThrow();
    expect(issues(at({ weightLb: 150.01 })).map((i) => i.path)).toContain("packages.0.weightLb");
    expect(() =>
      normalizeShippingLabelInput(at({ lengthIn: 108, widthIn: 1, heightIn: 1 }), US),
    ).not.toThrow();
    expect(issues(at({ lengthIn: 108.5, widthIn: 1, heightIn: 1 })).map((i) => i.path)).toContain(
      "packages.0.lengthIn",
    );
    // 100 + 2 * 30 + 2 * 2.5 = 165 passes; one more inch of height (167) does not.
    expect(() =>
      normalizeShippingLabelInput(at({ lengthIn: 100, widthIn: 30, heightIn: 2.5 }), US),
    ).not.toThrow();
    const over = issues(at({ lengthIn: 100, widthIn: 30, heightIn: 3.5 }));
    expect(over).toHaveLength(1);
    expect(over[0]?.path).toBe("packages.0");
    expect(over[0]?.message).toContain("167");
  });

  it.each([0, -1, Number.NaN])("rejects a non-positive dimension %s", (value) => {
    const input = base();
    input.packages = [{ ...pkg(), widthIn: value }];
    expect(issues(input).map((i) => i.path)).toContain("packages.0.widthIn");
  });

  it("caps packages and items per package", () => {
    const tooMany = base();
    tooMany.packages = Array.from({ length: SHIPPING_LABEL_MAX_PACKAGES + 1 }, pkg);
    expect(issues(tooMany).map((i) => i.path)).toContain("packages");
    const atCap = base();
    atCap.packages = Array.from({ length: SHIPPING_LABEL_MAX_PACKAGES }, pkg);
    expect(() => normalizeShippingLabelInput(atCap, US)).not.toThrow();

    const manyItems = base();
    manyItems.packages = [
      {
        ...pkg(),
        items: Array.from({ length: SHIPPING_LABEL_MAX_ITEMS_PER_PACKAGE + 1 }, (_, i) => ({
          sellerPartNumber: `SKU-${i}`,
          quantity: 1,
        })),
      },
    ];
    expect(issues(manyItems).map((i) => i.path)).toContain("packages.0.items");
    const noItems = base();
    noItems.packages = [{ ...pkg(), items: [] }];
    expect(issues(noItems).map((i) => i.path)).toContain("packages.0.items");
  });

  it.each([0, -1, 1.5, 100000])("rejects item quantity %s", (quantity) => {
    const input = base();
    input.packages = [{ ...pkg(), items: [{ sellerPartNumber: "SKU-1", quantity }] }];
    expect(issues(input).map((i) => i.path)).toContain("packages.0.items.0.quantity");
  });

  it("accepts item quantity 99999", () => {
    const input = base();
    input.packages = [{ ...pkg(), items: [{ sellerPartNumber: "SKU-1", quantity: 99999 }] }];
    expect(() => normalizeShippingLabelInput(input, US)).not.toThrow();
  });

  it("rejects blank and over-long text fields", () => {
    const blank = base();
    blank.shipFrom.firstName = "   ";
    expect(issues(blank).map((i) => i.path)).toContain("shipFrom.firstName");
    const long = base();
    long.shipFrom.address1 = "x".repeat(101);
    expect(issues(long).map((i) => i.path)).toContain("shipFrom.address1");
    const sku = base();
    sku.packages = [{ ...pkg(), items: [{ sellerPartNumber: "S".repeat(41), quantity: 1 }] }];
    expect(issues(sku).map((i) => i.path)).toContain("packages.0.items.0.sellerPartNumber");
  });

  it.each(["abc", "12", "<script>", "1".repeat(26)])("rejects phone number %j", (phoneNumber) => {
    const input = base();
    input.shipFrom.phoneNumber = phoneNumber;
    expect(issues(input).map((i) => i.path)).toContain("shipFrom.phoneNumber");
  });

  it.each(["C", "CAL", "1A"])("rejects state code %j", (stateCode) => {
    const input = base();
    input.shipFrom.stateCode = stateCode;
    expect(issues(input).map((i) => i.path)).toContain("shipFrom.stateCode");
  });

  it("rejects a country that is not alpha-3, and one that is for the other marketplace", () => {
    const notAlpha3 = base();
    notAlpha3.shipFrom.countryCode = "US";
    expect(issues(notAlpha3).map((i) => i.path)).toContain("shipFrom.countryCode");
    const otherMarket = base();
    otherMarket.shipFrom.countryCode = "CAN";
    expect(issues(otherMarket)[0]?.message).toContain("USA");
  });

  it("applies the marketplace service-code table", () => {
    const usInput = { ...base(), serviceCode: 111 };
    expect(issues(usInput)[0]?.message).toContain("101, 102, 103, 104, 105");
    const caInput = base();
    caInput.shipFrom.zipCode = "K1A 0B1";
    expect(issues({ ...caInput, serviceCode: 101 }, CA)[0]?.message).toContain(
      "111, 112, 113, 114",
    );
    expect(() => normalizeShippingLabelInput({ ...caInput, serviceCode: 114 }, CA)).not.toThrow();
  });

  it.each(["9000", "90001-12", "ABCDE"])("rejects US ZIP %j and accepts ZIP+4", (zipCode) => {
    const input = base();
    input.shipFrom.zipCode = zipCode;
    expect(issues(input).map((i) => i.path)).toContain("shipFrom.zipCode");
    input.shipFrom.zipCode = "90001-1234";
    expect(() => normalizeShippingLabelInput(input, US)).not.toThrow();
  });

  it("rejects a US ZIP on Newegg.ca", () => {
    expect(issues(base(), CA).map((i) => i.path)).toContain("shipFrom.zipCode");
  });

  it("lists every platform issue in a single error, one per bad package", () => {
    const input = base();
    input.serviceCode = 999;
    input.shipFrom.zipCode = "bad";
    input.packages = [
      { ...pkg(), lengthIn: 100, widthIn: 40, heightIn: 40 },
      { ...pkg(), lengthIn: 100, widthIn: 40, heightIn: 40 },
    ];
    expect(issues(input).map((i) => i.path)).toEqual([
      "serviceCode",
      "shipFrom.zipCode",
      "packages.0",
      "packages.1",
    ]);
  });

  it("names the failing request in the error message", () => {
    try {
      normalizeShippingLabelInput({} as ShippingLabelInput, US);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toBe("The shipping label request is invalid.");
    }
  });
});

describe("normalizeReprintInput", () => {
  it("returns the order number as a trimmed string", () => {
    expect(normalizeReprintInput(77)).toEqual({ orderNumber: "77" });
    expect(normalizeReprintInput(" 88 ")).toEqual({ orderNumber: "88" });
  });

  it.each(["0", "abc", "", "2147483648"])("rejects %j", (value) => {
    expect(() => normalizeReprintInput(value)).toThrow(NeweggValidationError);
  });
});
