import { describe, expect, it } from "vitest";
import { makeClient, paths } from "./helpers.js";

describe("service.getStatus", () => {
  it("reads the wrapped NeweggAPIResponse variant and defaults to contentmgmt", async () => {
    const { client, calls } = makeClient("us", [
      {
        method: "GET",
        pathPattern: paths.serviceStatus,
        reply: () => ({
          status: 200,
          body: {
            NeweggAPIResponse: {
              IsSuccess: "true",
              OperationType: "GetServiceStatus",
              SellerID: "A006",
              ResponseBody: { Status: "1", Timestamp: "2/15/2012 2:50:38" },
            },
          },
        }),
      },
    ]);
    const status = await client.service.getStatus();
    expect(status.available).toBe(true);
    expect(status.domain).toBe("contentmgmt");
    expect(calls[0]!.url.pathname).toBe("/marketplace/contentmgmt/servicestatus");
    expect(status.timestamp?.iso).toBe("2012-02-15T10:50:38.000Z");
  });

  it("reads an unwrapped response variant", async () => {
    const { client } = makeClient("us", [
      {
        method: "GET",
        pathPattern: paths.serviceStatus,
        reply: () => ({ status: 200, body: { ResponseBody: { Status: "1" } } }),
      },
    ]);
    const status = await client.service.getStatus("datafeedmgmt");
    expect(status.available).toBe(true);
    expect(status.domain).toBe("datafeedmgmt");
  });

  it("reports unavailable with a message when Status is 0", async () => {
    const { client } = makeClient("ca", [
      {
        method: "GET",
        pathPattern: paths.serviceStatus,
        reply: () => ({
          status: 200,
          body: {
            NeweggAPIResponse: { ResponseBody: { Status: "0", Message: "Down for maintenance" } },
          },
        }),
      },
    ]);
    const status = await client.service.getStatus();
    expect(status.available).toBe(false);
    expect(status.message).toBe("Down for maintenance");
  });
});
