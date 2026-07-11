import { describe, expect, it } from "vitest";
import { NeweggAuthenticationError } from "../src/index.js";
import { makeClient, paths } from "./helpers.js";

describe("client.verifyCredentials (read-only fail-fast preflight)", () => {
  it("resolves ok on a successful service-status read and issues exactly one GET", async () => {
    const { client, calls } = makeClient("ca", [
      {
        method: "GET",
        pathPattern: paths.serviceStatus,
        reply: () => ({
          status: 200,
          body: { ResponseBody: { Status: "1", Timestamp: "2/15/2012 2:50:38" } },
        }),
      },
    ]);

    const check = await client.verifyCredentials();

    expect(check.ok).toBe(true);
    expect(check.marketplace).toBe("ca");
    expect(check.domain).toBe("contentmgmt");
    expect(check.serviceAvailable).toBe(true);
    expect(check.timestamp?.iso).toBe("2012-02-15T10:50:38.000Z");

    // Exactly one call, a read-only GET to servicestatus — never a mutating request.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toContain("servicestatus");
    expect(calls[0]!.bodyText).toBeUndefined();
  });

  it("throws NeweggAuthenticationError fast on 401 (bad credentials)", async () => {
    const { client } = makeClient("ca", [
      {
        method: "GET",
        pathPattern: paths.serviceStatus,
        reply: () => ({
          status: 401,
          body: "Gateway: Seller Auth failed.",
          headers: { "Content-Type": "text/plain" },
        }),
      },
    ]);

    await expect(client.verifyCredentials()).rejects.toBeInstanceOf(NeweggAuthenticationError);
  });
});
