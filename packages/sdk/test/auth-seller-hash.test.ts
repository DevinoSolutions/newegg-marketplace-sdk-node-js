import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashSellerId } from "../src/auth/index.js";
import { capturingLogger, makeClient, paths, US_SINGLE_ITEM } from "./helpers.js";

const plainSha256Prefix = (id: string): string =>
  createHash("sha256").update(id).digest("hex").slice(0, 12);

describe("hashSellerId (T-6213)", () => {
  it("is not the unkeyed sha-256 prefix, so it cannot be recovered by enumeration", () => {
    const target = hashSellerId("C76Q");
    expect(target).not.toBe(plainSha256Prefix("C76Q"));

    // Seller ids are 4-6 alphanumerics; enumerate a slice of that space with the old scheme.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const recovered: string[] = [];
    for (const a of alphabet) {
      for (const b of alphabet) {
        for (const c of "C76") {
          for (const d of "Q0") {
            const candidate = `${a}${b}${c}${d}`;
            if (plainSha256Prefix(candidate) === target) recovered.push(candidate);
          }
        }
      }
    }
    expect(recovered).toEqual([]);
  });

  it("is a stable 12-hex correlation value within one process", () => {
    const first = hashSellerId("C76Q");
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(hashSellerId("C76Q")).toBe(first);
    expect(hashSellerId("C76R")).not.toBe(first);
  });

  it("uses a per-process random key: a fresh module instance yields a different value", async () => {
    const here = hashSellerId("C76Q");
    vi.resetModules();
    const fresh = await import("../src/auth/index.js");
    expect(fresh.hashSellerId("C76Q")).not.toBe(here);
  });

  it("log events carry the in-process keyed hash and no raw or plain-hashed seller id", async () => {
    const { logger, entries } = capturingLogger();
    const { client } = makeClient(
      "us",
      [
        {
          method: "PUT",
          pathPattern: paths.usInventory,
          reply: () => ({ status: 200, body: US_SINGLE_ITEM }),
        },
      ],
      { logger, sellerId: "C76Q" },
    );
    await client.inventory.getItem({ identifier: { type: "sellerPartNumber", value: "sku" } });

    const hashes = entries
      .map((entry) => entry.fields?.sellerIdHash)
      .filter((value): value is string => typeof value === "string");
    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) {
      expect(hash).toBe(hashSellerId("C76Q"));
      expect(hash).not.toBe(plainSha256Prefix("C76Q"));
    }
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain("C76Q");
    expect(dump).not.toContain(plainSha256Prefix("C76Q"));
  });
});
