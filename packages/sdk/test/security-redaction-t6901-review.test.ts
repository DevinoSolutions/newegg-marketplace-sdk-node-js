import { describe, expect, it } from "vitest";
import { NeweggValidationError } from "../src/index.js";

// T-6901 review follow-up on PR #78: the constructor must never throw on malformed issues (a throw
// inside an error constructor hides the original error). Fixture secrets are made up.

const SEKRIT = "SEKRIT-VALUE";

const build = (issues: unknown): NeweggValidationError =>
  new NeweggValidationError("bad input", issues as never);

describe("NeweggValidationError tolerates malformed issues", () => {
  it("does not throw on a missing path, a non-string message, null items or a non-array", () => {
    const shapes: unknown[] = [
      [{ path: undefined, message: "m" }],
      [{ path: "p", message: 42 }],
      [{ message: "only a message" }],
      [null],
      [undefined, "text", 7],
      undefined,
      null,
      "not an array",
      { path: "p", message: "m" },
    ];
    for (const shape of shapes) {
      let error: NeweggValidationError | undefined;
      expect(() => {
        error = build(shape);
      }, JSON.stringify(shape)).not.toThrow();
      expect(error).toBeInstanceOf(NeweggValidationError);
      expect(error?.code).toBe("validation");
    }
  });

  it("passes non-array issues and non-object items through unchanged", () => {
    expect(build("not an array").issues).toBe("not an array");
    expect(build(undefined).issues).toBeUndefined();
    expect(build([null, "text", 7]).issues).toEqual([null, "text", 7]);
    expect(build([{ path: "p", message: 42 }]).issues).toEqual([{ path: "p", message: 42 }]);
  });

  it("still redacts string paths and messages next to malformed fields", () => {
    const error = build([
      { path: undefined, message: `Authorization: Bearer ${SEKRIT} rejected` },
      { path: `query?sellerid=${SEKRIT}`, message: 42 },
      null,
    ]);
    expect(JSON.stringify(error.issues)).not.toContain(SEKRIT);
    expect(JSON.stringify(error.toJSON())).not.toContain(SEKRIT);
    expect(error.issues[2]).toBeNull();
  });
});
