import { describe, expect, it } from "vitest";
import {
  isFollowedRedirect,
  MAX_READ_REDIRECTS,
  REDIRECT_REFUSED_CROSS_ORIGIN,
  REDIRECT_REFUSED_DOWNGRADE,
  REDIRECT_REFUSED_INVALID_LOCATION,
  redirectedMethod,
  resolveRedirectTarget,
} from "../../src/client/redirect.js";

const ORIGINAL = new URL(
  "https://api.newegg.com/marketplace/ordermgmt/order/orderinfo?sellerid=A006",
);

describe("isFollowedRedirect", () => {
  it.each([301, 302, 303, 307, 308])("follows %i with a Location", (status) => {
    expect(isFollowedRedirect(status, "/next")).toBe(true);
  });

  it.each([200, 300, 304, 305, 404, 500])("does not follow %i", (status) => {
    expect(isFollowedRedirect(status, "/next")).toBe(false);
  });

  it("does not follow a redirect without a usable Location", () => {
    expect(isFollowedRedirect(302, null)).toBe(false);
    expect(isFollowedRedirect(302, "")).toBe(false);
  });

  it("has a positive hop budget", () => {
    expect(MAX_READ_REDIRECTS).toBeGreaterThan(0);
  });
});

describe("resolveRedirectTarget", () => {
  it("resolves a relative Location against the current URL", () => {
    const next = resolveRedirectTarget(ORIGINAL, ORIGINAL, "/marketplace/other?x=1");
    expect(next).toBeInstanceOf(URL);
    expect((next as URL).toString()).toBe("https://api.newegg.com/marketplace/other?x=1");
  });

  it("accepts an absolute same-origin Location", () => {
    expect(
      resolveRedirectTarget(ORIGINAL, ORIGINAL, "https://api.newegg.com/elsewhere"),
    ).toBeInstanceOf(URL);
  });

  it("refuses a different host", () => {
    expect(resolveRedirectTarget(ORIGINAL, ORIGINAL, "https://evil.example/steal")).toBe(
      REDIRECT_REFUSED_CROSS_ORIGIN,
    );
  });

  it("refuses a different port", () => {
    expect(resolveRedirectTarget(ORIGINAL, ORIGINAL, "https://api.newegg.com:8443/x")).toBe(
      REDIRECT_REFUSED_CROSS_ORIGIN,
    );
  });

  it("refuses an https to http downgrade with its own reason", () => {
    expect(resolveRedirectTarget(ORIGINAL, ORIGINAL, "http://api.newegg.com/x")).toBe(
      REDIRECT_REFUSED_DOWNGRADE,
    );
  });

  it("refuses a different scheme with the same inner origin", () => {
    expect(
      resolveRedirectTarget(ORIGINAL, ORIGINAL, "blob:https://api.newegg.com/uuid"),
    ).not.toBeInstanceOf(URL);
  });

  it("refuses embedded credentials", () => {
    expect(resolveRedirectTarget(ORIGINAL, ORIGINAL, "https://u:p@api.newegg.com/x")).toBe(
      REDIRECT_REFUSED_INVALID_LOCATION,
    );
  });

  it("refuses an unparseable Location", () => {
    expect(resolveRedirectTarget(ORIGINAL, ORIGINAL, "http://[bad")).toBe(
      REDIRECT_REFUSED_INVALID_LOCATION,
    );
  });

  it("checks against the ORIGINAL origin, not the current hop", () => {
    const hop = new URL("https://api.newegg.com/hop");
    expect(resolveRedirectTarget(ORIGINAL, hop, "https://other.newegg.com/x")).toBe(
      REDIRECT_REFUSED_CROSS_ORIGIN,
    );
  });

  it("allows same-origin redirects between loopback http URLs only", () => {
    const local = new URL("http://127.0.0.1:9000/a");
    expect(resolveRedirectTarget(local, local, "/b")).toBeInstanceOf(URL);
    expect(resolveRedirectTarget(local, local, "http://127.0.0.1:9001/b")).toBe(
      REDIRECT_REFUSED_CROSS_ORIGIN,
    );
  });
});

describe("redirectedMethod", () => {
  it("turns a 303 into a GET and drops the body, except for GET/HEAD", () => {
    expect(redirectedMethod(303, "PUT")).toEqual({ method: "GET", dropBody: true });
    expect(redirectedMethod(303, "POST")).toEqual({ method: "GET", dropBody: true });
    expect(redirectedMethod(303, "GET")).toEqual({ method: "GET", dropBody: false });
    expect(redirectedMethod(303, "head")).toEqual({ method: "head", dropBody: false });
  });

  it("turns only a POST into a GET on 301 and 302", () => {
    expect(redirectedMethod(301, "POST")).toEqual({ method: "GET", dropBody: true });
    expect(redirectedMethod(302, "post")).toEqual({ method: "GET", dropBody: true });
    expect(redirectedMethod(301, "PUT")).toEqual({ method: "PUT", dropBody: false });
    expect(redirectedMethod(302, "GET")).toEqual({ method: "GET", dropBody: false });
  });

  it("never changes the request on 307 and 308", () => {
    expect(redirectedMethod(307, "POST")).toEqual({ method: "POST", dropBody: false });
    expect(redirectedMethod(308, "PUT")).toEqual({ method: "PUT", dropBody: false });
  });
});
