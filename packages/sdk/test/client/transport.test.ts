import { describe, expect, it } from "vitest";
import { classifyTransport, REDIRECT_REFUSED, TransportError } from "../../src/client/transport.js";

describe("classifyTransport", () => {
  it("re-throws a caller abort unchanged", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(classifyTransport(abort, true)).toBe(abort);
  });

  it("treats a non-caller abort as an ambiguous timeout", () => {
    const result = classifyTransport(new DOMException("t", "TimeoutError"), false);
    expect(result).toBeInstanceOf(TransportError);
    expect(result).toMatchObject({ phase: "ambiguous", timeout: true });
  });

  it.each(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"])("%s on the cause is pre-send", (code) => {
    const err = new TypeError("fetch failed", { cause: { code } });
    expect(classifyTransport(err, false)).toMatchObject({
      phase: "pre-send",
      timeout: false,
      causeCode: code,
    });
  });

  it("reads a top-level code too", () => {
    expect(classifyTransport({ code: "ECONNREFUSED" }, false)).toMatchObject({
      phase: "pre-send",
      causeCode: "ECONNREFUSED",
    });
  });

  it.each(["ECONNRESET", "EPIPE", "ETIMEDOUT"])("%s is ambiguous", (code) => {
    const err = new TypeError("fetch failed", { cause: { code } });
    expect(classifyTransport(err, false)).toMatchObject({
      phase: "ambiguous",
      timeout: false,
      causeCode: code,
    });
  });

  it("classifies an unknown failure as ambiguous without a code", () => {
    const result = classifyTransport(new Error("weird"), false) as TransportError;
    expect(result).toBeInstanceOf(TransportError);
    expect(result.phase).toBe("ambiguous");
    expect(result.causeCode).toBeUndefined();
    expect(result.cause).toBeInstanceOf(Error);
  });

  it("recognizes the unexpected-redirect refusal raised by fetch", () => {
    const err = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    expect(classifyTransport(err, false)).toMatchObject({
      phase: "ambiguous",
      timeout: false,
      causeCode: REDIRECT_REFUSED,
    });
  });
});
