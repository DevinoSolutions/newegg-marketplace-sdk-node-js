import { describe, expect, it } from "vitest";
import { NeweggValidationError } from "../../src/errors/index.js";
import { LabelCreateGuardError, priorAttemptMessage } from "../../src/shippinglabel/guard-error.js";
import type { LabelCreateAttempt } from "../../src/types.js";
import { TEST_API_KEY, TEST_SECRET_KEY } from "../helpers.js";

const submitting: LabelCreateAttempt = {
  state: "submitting",
  attemptId: "attempt-0001",
  atIso: "2026-10-20T00:00:00.000Z",
};
const submitted: LabelCreateAttempt = {
  ...submitting,
  state: "submitted",
  attemptId: "attempt-0002",
};

describe("priorAttemptMessage", () => {
  it("describes an unknown outcome and names the acknowledgement id", () => {
    const text = priorAttemptMessage("900000001", submitting, undefined);
    expect(text).toContain("order 900000001");
    expect(text).toContain("outcome is unknown");
    expect(text).toContain(submitting.atIso);
    expect(text).toContain('acknowledgePriorAttemptId "attempt-0001"');
    expect(text).toContain("Nothing is retried automatically");
  });

  it("describes a confirmed purchase differently", () => {
    const text = priorAttemptMessage("900000001", submitted, undefined);
    expect(text).toContain("completed (a label was bought)");
    expect(text).not.toContain("outcome is unknown");
  });

  it("appends the reason an acknowledgement was rejected", () => {
    const text = priorAttemptMessage("900000001", submitting, "The id given is stale.");
    expect(text.endsWith(" The id given is stale.")).toBe(true);
  });

  it("uses caller guidance instead of the acknowledgement remedy and leaves the attempt id out", () => {
    const text = priorAttemptMessage("900000001", submitting, "ignored", "Verify in the portal.");
    expect(text.endsWith("Verify in the portal.")).toBe(true);
    expect(text).toContain("Nothing was sent");
    expect(text).not.toContain("attempt-0001");
    expect(text).not.toContain("acknowledgePriorAttemptId");
    expect(text).not.toContain("ignored");
  });
});

describe("LabelCreateGuardError", () => {
  const err = new LabelCreateGuardError("blocked", "900000001", submitting);

  it("is a validation error with a stable name and fields", () => {
    expect(err).toBeInstanceOf(NeweggValidationError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LabelCreateGuardError");
    expect(err.orderNumber).toBe("900000001");
    expect(err.attempt).toEqual(submitting);
    expect(err.message).toBe("blocked");
    expect(err.retryable).toBe(false);
  });

  it("serializes to JSON with the order, the attempt and the issue, and nothing else sensitive", () => {
    const json = err.toJSON();
    expect(json).toMatchObject({
      name: "LabelCreateGuardError",
      message: "blocked",
      orderNumber: "900000001",
      attempt: submitting,
    });
    expect(JSON.parse(JSON.stringify(err))).toEqual(JSON.parse(JSON.stringify(json)));
    const text = JSON.stringify(json) + priorAttemptMessage("900000001", submitting, undefined);
    for (const secret of [TEST_API_KEY, TEST_SECRET_KEY]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/authorization|secretkey/i);
  });

  it("reports the blocking issue at orderNumber", () => {
    expect(err.issues).toEqual([
      { path: "orderNumber", message: "a prior label create blocks this one" },
    ]);
  });
});
