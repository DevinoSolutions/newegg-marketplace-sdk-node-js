import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/client/config.js";
import { NeweggConfigurationError } from "../../src/errors/index.js";
import { InMemoryOperationStore } from "../../src/index.js";
import { LabelCreateLedger } from "../../src/shippinglabel/ledger.js";
import type { NeweggClientConfig } from "../../src/types.js";

const stubFetch = (() => Promise.resolve(new Response("{}"))) as typeof globalThis.fetch;
const HOUR = 3_600_000;

function base(overrides: Partial<NeweggClientConfig> = {}): NeweggClientConfig {
  return {
    sellerId: "A006",
    apiKey: "key-abc",
    secretKey: "secret-xyz",
    marketplace: "us",
    fetch: stubFetch,
    ...overrides,
  };
}

describe("labelCreateGuardWindowMs", () => {
  it("defaults to 24 hours", () => {
    expect(resolveConfig(base()).labelCreateGuardWindowMs).toBe(24 * HOUR);
  });

  it("accepts the inclusive bounds 1 hour and 30 days", () => {
    expect(resolveConfig(base({ labelCreateGuardWindowMs: HOUR })).labelCreateGuardWindowMs).toBe(
      HOUR,
    );
    expect(
      resolveConfig(base({ labelCreateGuardWindowMs: 30 * 24 * HOUR })).labelCreateGuardWindowMs,
    ).toBe(30 * 24 * HOUR);
  });

  it.each([0, HOUR - 1, 30 * 24 * HOUR + 1, 1.5 * HOUR, Number.NaN, Infinity, -HOUR, "24"])(
    "rejects %s",
    (value) => {
      const config = base({ labelCreateGuardWindowMs: value as unknown as number });
      expect(() => resolveConfig(config)).toThrow(NeweggConfigurationError);
      expect(() => resolveConfig(config)).toThrow(/labelCreateGuardWindowMs/);
    },
  );

  it("is the window the ledger enforces", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = new Date("2026-10-22T00:00:00.000Z");
      vi.setSystemTime(t0);
      const ledger = new LabelCreateLedger(new InMemoryOperationStore(), 72 * HOUR);
      const key = LabelCreateLedger.key("us", "5");
      ledger.claim(key, "a1", "h", undefined);
      vi.setSystemTime(new Date(t0.getTime() + 48 * HOUR));
      expect("refused" in ledger.claim(key, "a2", "h", undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
