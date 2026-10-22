import { describe, expect, it } from "vitest";
import {
  checkCreateAgainstOrder,
  checkReprintAgainstOrder,
  newLabelFindings,
  type LabelFindings,
} from "../../src/shippinglabel/checks.js";
import { getShippingLabelPlatform } from "../../src/platform/shipping-label.js";
import type { Order, ShippingLabelInput } from "../../src/types.js";

const US = getShippingLabelPlatform("us");
const CA = getShippingLabelPlatform("ca");

const input = (
  packages: ShippingLabelInput["packages"] = [
    {
      weightLb: 1,
      lengthIn: 1,
      widthIn: 1,
      heightIn: 1,
      items: [{ sellerPartNumber: "SKU-1", quantity: 2 }],
    },
  ],
): ShippingLabelInput => ({
  orderNumber: "900000001",
  shipFrom: {
    firstName: "T",
    lastName: "S",
    phoneNumber: "5550100",
    address1: "1 Way",
    city: "City",
    stateCode: "CA",
    zipCode: "90001",
    countryCode: "USA",
  },
  packages,
});

function order(overrides: Partial<Order> = {}): Order {
  return {
    orderNumber: "900000001",
    status: "unshipped",
    fulfillment: "seller",
    customer: { shipTo: { countryCode: "US" } },
    amounts: {},
    items: [{ sellerPartNumber: "SKU-1", orderedQty: 2, status: "unshipped" }],
    packages: [],
    ...overrides,
  } as Order;
}

function create(
  o: Order | undefined,
  i: ShippingLabelInput = input(),
  platform = US,
): LabelFindings {
  const findings = newLabelFindings();
  checkCreateAgainstOrder(o, i, platform, findings);
  return findings;
}

const joined = (list: string[]): string => list.join("\n");

describe("checkCreateAgainstOrder", () => {
  it("passes a clean unshipped seller-fulfilled order with only the standing warning", () => {
    const f = create(order());
    expect(f.blockers).toEqual([]);
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("cannot be undone");
  });

  it("blocks a missing order (SL002) and stops there", () => {
    const f = create(undefined);
    expect(f.blockers).toHaveLength(1);
    expect(f.blockers[0]).toContain("SL002");
    expect(f.warnings).toEqual([]);
  });

  it("blocks a Newegg-fulfilled order (SL004) but keeps checking the rest", () => {
    const f = create(order({ fulfillment: "newegg" }));
    expect(f.blockers).toHaveLength(1);
    expect(f.blockers[0]).toContain("SL004");
    expect(f.warnings.length).toBeGreaterThan(0);
  });

  it.each(["shipped", "partiallyShipped", "invoiced", "voided", "unknown"] as const)(
    "blocks an order that is %s (SL003)",
    (status) => {
      const f = create(order({ status }));
      expect(joined(f.blockers)).toContain("SL003");
      expect(joined(f.blockers)).toContain(status);
    },
  );

  it("warns, without blocking, when an unshipped order already lists packages", () => {
    const f = create(order({ packages: [{}, {}] as Order["packages"] }));
    expect(f.blockers).toEqual([]);
    expect(joined(f.warnings)).toContain("already lists 2 package(s)");
  });

  it("does not warn about listed packages on an order that is not unshipped", () => {
    const f = create(order({ status: "shipped", packages: [{}] as Order["packages"] }));
    expect(joined(f.warnings)).not.toContain("already lists");
  });

  it("blocks a part number that is not on the order (SL010)", () => {
    const f = create(
      order(),
      input([{ ...input().packages[0]!, items: [{ sellerPartNumber: "OTHER", quantity: 2 }] }]),
    );
    expect(joined(f.blockers)).toContain("OTHER");
    expect(joined(f.blockers)).toContain("SL010");
  });

  it("ignores cancelled and part-number-less lines when matching (SL010)", () => {
    const o = order({
      items: [
        { sellerPartNumber: "SKU-1", orderedQty: 2, status: "unshipped" },
        { sellerPartNumber: "GONE", orderedQty: 1, status: "cancelled" },
        { orderedQty: 1, status: "unshipped" },
      ] as Order["items"],
    });
    const f = create(
      o,
      input([{ ...input().packages[0]!, items: [{ sellerPartNumber: "GONE", quantity: 1 }] }]),
    );
    expect(joined(f.blockers)).toContain("GONE");
    expect(joined(f.blockers)).toContain("SL010");
  });

  it("requires each line to ship its entire quantity (SL005), summing across packages", () => {
    const short = create(
      order(),
      input([{ ...input().packages[0]!, items: [{ sellerPartNumber: "SKU-1", quantity: 1 }] }]),
    );
    expect(joined(short.blockers)).toContain("SL005");
    expect(joined(short.blockers)).toContain("1 requested but 2 ordered");

    const split = create(
      order(),
      input([
        { ...input().packages[0]!, items: [{ sellerPartNumber: "SKU-1", quantity: 1 }] },
        { ...input().packages[0]!, items: [{ sellerPartNumber: "SKU-1", quantity: 1 }] },
      ]),
    );
    expect(split.blockers).toEqual([]);
  });

  it("sums duplicate order lines for the same part number", () => {
    const o = order({
      items: [
        { sellerPartNumber: "SKU-1", orderedQty: 1, status: "unshipped" },
        { sellerPartNumber: "SKU-1", orderedQty: 1, status: "unshipped" },
      ] as Order["items"],
    });
    expect(create(o).blockers).toEqual([]);
  });

  it("skips the quantity check when the order does not report a quantity", () => {
    const o = order({
      items: [{ sellerPartNumber: "SKU-1", status: "unshipped" }] as Order["items"],
    });
    expect(create(o).blockers).toEqual([]);
  });

  it("warns about open lines the request leaves out", () => {
    const o = order({
      items: [
        { sellerPartNumber: "SKU-1", orderedQty: 2, status: "unshipped" },
        { sellerPartNumber: "SKU-2", orderedQty: 1, status: "unshipped" },
      ] as Order["items"],
    });
    const f = create(o);
    expect(f.blockers).toEqual([]);
    expect(joined(f.warnings)).toContain("stay unshipped: SKU-2");
  });

  it.each(["US", "USA", "usa", " United States ", "UNITED STATES OF AMERICA"])(
    "accepts the US spelling %j on Newegg.com",
    (countryCode) => {
      expect(
        create(order({ customer: { shipTo: { countryCode } } as Order["customer"] })).blockers,
      ).toEqual([]);
    },
  );

  it.each(["CA", "CAN", "Canada", "MX"])(
    "blocks a %s destination on Newegg.com (SL015)",
    (countryCode) => {
      const f = create(order({ customer: { shipTo: { countryCode } } as Order["customer"] }));
      expect(joined(f.blockers)).toContain("SL015");
      expect(joined(f.blockers)).toContain(countryCode);
    },
  );

  it("does not block when the destination is absent or empty", () => {
    expect(create(order({ customer: undefined })).blockers).toEqual([]);
    expect(
      create(order({ customer: { shipTo: { countryCode: "" } } as Order["customer"] })).blockers,
    ).toEqual([]);
  });

  it("replaces the destination check with a SL015 warning on Newegg.ca", () => {
    const f = create(
      order({ customer: { shipTo: { countryCode: "CA" } } as Order["customer"] }),
      input(),
      CA,
    );
    expect(f.blockers).toEqual([]);
    expect(joined(f.warnings)).toContain("SL015 documents USA domestic transportation only");
  });

  it("warns about the signature surcharge only when a package asks for one", () => {
    const plain = create(order());
    expect(joined(plain.warnings)).not.toContain("signature");
    const signed = create(order(), input([{ ...input().packages[0]!, signatureRequired: true }]));
    expect(joined(signed.warnings)).toContain("signature requirement adds a carrier surcharge");
    const explicitFalse = create(
      order(),
      input([{ ...input().packages[0]!, signatureRequired: false }]),
    );
    expect(joined(explicitFalse.warnings)).not.toContain("surcharge");
  });

  it("accumulates into findings it is handed rather than replacing them", () => {
    const findings: LabelFindings = { blockers: ["earlier"], warnings: ["earlier warning"] };
    checkCreateAgainstOrder(order({ status: "shipped" }), input(), US, findings);
    expect(findings.blockers[0]).toBe("earlier");
    expect(findings.warnings[0]).toBe("earlier warning");
    expect(findings.blockers.length).toBeGreaterThan(1);
  });
});

describe("checkReprintAgainstOrder", () => {
  const run = (o: Order | undefined): LabelFindings => {
    const findings = newLabelFindings();
    checkReprintAgainstOrder(o, findings);
    return findings;
  };

  it.each(["shipped", "partiallyShipped"] as const)(
    "allows a %s order with a billing warning",
    (status) => {
      const f = run(order({ status }));
      expect(f.blockers).toEqual([]);
      expect(joined(f.warnings)).toContain("treated as billable");
    },
  );

  it.each(["unshipped", "invoiced", "voided", "unknown"] as const)(
    "blocks a %s order",
    (status) => {
      expect(joined(run(order({ status })).blockers)).toContain(`The order is ${status}`);
    },
  );

  it("blocks a missing order and a Newegg-fulfilled one", () => {
    expect(joined(run(undefined).blockers)).toContain("SL002");
    expect(joined(run(order({ status: "shipped", fulfillment: "newegg" })).blockers)).toContain(
      "SL004",
    );
  });
});
