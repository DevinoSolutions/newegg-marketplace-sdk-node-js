import { describe, expect, it } from "vitest";
import { NeweggValidationError, type SubmitRmaInput } from "../src/index.js";
import { makeClient } from "./helpers.js";
import { ORDER_NUMBER, SKU, readRoutes } from "./service-write-helpers.js";

// T-5673 (I1): RMA evidence image URLs are fetched by Newegg, so only plain https URLs without
// embedded credentials may be sent.

function input(imageUrls: string[]): SubmitRmaInput {
  return {
    orderNumber: ORDER_NUMBER,
    type: "refund",
    items: [
      {
        sellerPartNumber: SKU,
        returnQuantity: 1,
        reason: "defective",
        returnUnitPrice: 40,
        refundShippingPrice: 0,
        imageUrls,
      },
    ],
  };
}

async function validationIssues(imageUrls: string[]): Promise<string | undefined> {
  const { client, calls } = makeClient("ca", readRoutes({}));
  const result = await client.rma.previewSubmit(input(imageUrls)).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (result === undefined) return undefined;
  expect(result).toBeInstanceOf(NeweggValidationError);
  expect(calls).toHaveLength(0);
  return (result as NeweggValidationError).issues.map((i) => `${i.path}: ${i.message}`).join("\n");
}

describe("RMA imageUrls accept https without userinfo only (T-5673 / I1)", () => {
  it("rejects plain http", async () => {
    expect(await validationIssues(["http://img.example/a.jpg"])).toContain("https");
  });

  it("rejects userinfo, with or without a password", async () => {
    expect(await validationIssues(["https://user:secret@img.example/a.jpg"])).toContain("https");
    expect(await validationIssues(["https://token@img.example/a.jpg"])).toContain("https");
  });

  it("rejects other schemes and unparseable values", async () => {
    for (const bad of [
      "ftp://img.example/a.jpg",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "x",
    ]) {
      expect(await validationIssues([bad])).toBeDefined();
    }
  });

  it("never echoes the credentials of a rejected URL in the validation message", async () => {
    const issues = await validationIssues(["https://user:s3cretpw@img.example/a.jpg"]);
    expect(issues).toBeDefined();
    expect(issues).not.toContain("s3cretpw");
  });

  it("accepts a plain https URL", async () => {
    expect(await validationIssues(["https://img.example/a.jpg"])).toBeUndefined();
  });
});
