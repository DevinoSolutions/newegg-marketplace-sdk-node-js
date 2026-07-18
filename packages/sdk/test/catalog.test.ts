import { describe, expect, it } from "vitest";
import {
  buildLookupResultRequest,
  buildLookupSubmitRequest,
  buildStatusRequest,
  parseLookupResultResponse,
  parseStatusResponse,
  parseSubmitResponse,
} from "../src/catalog/parse.js";
import { CatalogLookupTimeoutError, NeweggValidationError } from "../src/errors/index.js";
import { makeClient, paths } from "./helpers.js";

// ---------------------------------------------------------------------------
// builders (contracts §12)
// ---------------------------------------------------------------------------
describe("catalog request builders", () => {
  it("builds a lookup submit body from mixed upc and mpn inputs", () => {
    const body = buildLookupSubmitRequest([
      { upc: "812674021181", condition: "new" },
      { manufacturer: "Corsair", manufacturerPartNumber: "CSSD-F2000GBMP700MCS", packsOrSets: 1 },
    ]);
    expect(body).toEqual({
      OperationType: "ItemLookupRequest",
      RequestBody: {
        RequestCriteria: {
          Item: [
            { UPC: "812674021181", Condition: 1 },
            {
              ManufacturerName: "Corsair",
              ManufacturerPartNumber: "CSSD-F2000GBMP700MCS",
              PacksOrSets: 1,
            },
          ],
        },
      },
    });
  });

  it("builds a status body with the GetRequestStatus wrapper (§12.2)", () => {
    expect(buildStatusRequest("2PQBYWH4V68ZP")).toEqual({
      OperationType: "GetReportStatusRequest",
      RequestBody: {
        GetRequestStatus: { RequestIDList: { RequestID: "2PQBYWH4V68ZP" }, MaxCount: 100 },
      },
    });
  });

  it("builds a result body with paging", () => {
    expect(buildLookupResultRequest("2PQBYWH4V68ZP", 2)).toEqual({
      OperationType: "ItemLookupRequest",
      RequestBody: { RequestID: "2PQBYWH4V68ZP", PageInfo: { PageIndex: 2, PageSize: 100 } },
    });
  });
});

// ---------------------------------------------------------------------------
// parsers (contracts §12 fixtures)
// ---------------------------------------------------------------------------
describe("catalog response parsers", () => {
  it("extracts the request id from the ResponseList (JSON array form, §12.1)", () => {
    expect(
      parseSubmitResponse({
        IsSuccess: true,
        OperationType: "ItemLookupReportResponse",
        SellerID: "a001",
        ResponseBody: {
          ResponseList: [
            {
              RequestId: "270Z8Y3SYIGQV",
              RequestType: "ITEM_LOOKUP",
              RequestDate: "07/12/2014 11:34:57",
              RequestStatus: "SUBMITTED",
            },
          ],
        },
      }).requestId,
    ).toBe("270Z8Y3SYIGQV");
  });

  it("tolerates the XML-shaped ResponseInfo nesting and RequestID casing", () => {
    expect(
      parseSubmitResponse({
        ResponseBody: { ResponseList: { ResponseInfo: { RequestID: "REQ456" } } },
      }).requestId,
    ).toBe("REQ456");
  });

  it("throws NeweggApiError when a submit response has no request id", () => {
    expect(() => parseSubmitResponse({ IsSuccess: true, ResponseBody: {} })).toThrowError(
      /request id/i,
    );
  });

  it("maps status strings (object-OR-array ResponseList) to the state union", () => {
    const single = parseStatusResponse(
      { ResponseBody: { ResponseList: { RequestId: "R1", RequestStatus: "IN_PROGRESS" } } },
      "R1",
    );
    expect(single.status).toBe("inProgress");
    const finished = parseStatusResponse(
      { ResponseBody: { ResponseList: [{ RequestId: "R1", RequestStatus: "FINISHED" }] } },
      "R1",
    );
    expect(finished.status).toBe("finished");
  });

  it("prefers the entry matching the request id when several are returned", () => {
    const parsed = parseStatusResponse(
      {
        ResponseBody: {
          ResponseList: [
            { RequestId: "OTHER", RequestStatus: "FINISHED" },
            { RequestId: "MINE", RequestStatus: "SUBMITTED" },
          ],
        },
      },
      "MINE",
    );
    expect(parsed.status).toBe("submitted");
  });

  it("returns unknown (with the raw string) for unrecognized statuses", () => {
    const parsed = parseStatusResponse(
      { ResponseBody: { ResponseList: [{ RequestId: "R", RequestStatus: "WEIRD" }] } },
      "R",
    );
    expect(parsed.status).toBe("unknown");
    expect(parsed.statusRaw).toBe("WEIRD");
  });

  it("parses a result page (§12.3 fixture) skipping miss rows without NeweggItemNumber", () => {
    const page = parseLookupResultResponse({
      IsSuccess: true,
      OperationType: "ItemLookupResponse",
      SellerID: "A006",
      ResponseBody: {
        PageInfo: { TotalCount: "2", TotalPageCount: "1", PageIndex: "1", PageSize: "100" },
        RequestID: "27YV8H1HHRFLZ",
        ItemList: [
          {
            ManufacturerName: "Plantronics",
            ManufacturerPartNumber: "203500-105",
            Condition: 1,
            Note: "No match found.",
          },
          {
            NeweggItemNumber: "0G6-0008-003W9",
            UPC: "017229164116",
            Condition: "1",
            PacksOrSets: "1",
            ManufacturerName: "Plantronics",
            ManufacturerPartNumber: "206110-101",
            WebsiteShortTitle: "Plantronics Voyager 5200 UC Earset",
          },
        ],
      },
    });
    expect(page.totalCount).toBe(2);
    expect(page.totalPageCount).toBe(1);
    expect(page.matches).toEqual([
      {
        neweggItemNumber: "0G6-0008-003W9",
        upc: "017229164116",
        condition: "new",
        packsOrSets: 1,
        manufacturer: "Plantronics",
        manufacturerPartNumber: "206110-101",
        websiteShortTitle: "Plantronics Voyager 5200 UC Earset",
      },
    ]);
  });

  it("tolerates the XML-shaped ItemList > Item nesting with a single object", () => {
    const page = parseLookupResultResponse({
      ResponseBody: {
        PageInfo: { TotalCount: 1, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
        ItemList: { Item: { NeweggItemNumber: "9SIA1", UPC: "812674021181" } },
      },
    });
    expect(page.matches).toEqual([{ neweggItemNumber: "9SIA1", upc: "812674021181" }]);
  });
});

// ---------------------------------------------------------------------------
// lifecycle primitives against the mock transport
// ---------------------------------------------------------------------------
const SUBMIT_OK = {
  IsSuccess: true,
  OperationType: "ItemLookupReportResponse",
  SellerID: "A006",
  ResponseBody: {
    ResponseList: [{ RequestId: "REQ123", RequestType: "ITEM_LOOKUP", RequestStatus: "SUBMITTED" }],
  },
};
const STATUS_FINISHED = {
  ResponseBody: { ResponseList: [{ RequestId: "REQ123", RequestStatus: "FINISHED" }] },
};
const STATUS_IN_PROGRESS = {
  ResponseBody: { ResponseList: [{ RequestId: "REQ123", RequestStatus: "IN_PROGRESS" }] },
};
const RESULT_PAGE = {
  ResponseBody: {
    PageInfo: { TotalCount: "1", TotalPageCount: "1", PageIndex: "1", PageSize: "100" },
    RequestID: "REQ123",
    ItemList: [{ NeweggItemNumber: "9SIA0060884598", UPC: "812674021181", Condition: "1" }],
  },
};

describe("catalog.submitLookup / lookupStatus / lookupResult", () => {
  it("submits via POST to reportmgmt and returns the request id", async () => {
    const { client, calls } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: SUBMIT_OK }),
      },
    ]);
    const submission = await client.catalog.submitLookup([{ upc: "812674021181" }]);
    expect(submission.requestId).toBe("REQ123");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toContain("can/reportmgmt/report/submitrequest");
  });

  it("rejects an empty list and neweggItemNumber inputs with NeweggValidationError", async () => {
    const { client, calls } = makeClient("ca", []);
    await expect(client.catalog.submitLookup([])).rejects.toBeInstanceOf(NeweggValidationError);
    await expect(
      client.catalog.submitLookup([{ neweggItemNumber: "9SIA1" }]),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });

  it("rejects more than 1000 items per submission (RP021)", async () => {
    const { client } = makeClient("ca", []);
    const inputs = Array.from({ length: 1001 }, (_, i) => ({
      upc: String(i).padStart(12, "0"),
    }));
    await expect(client.catalog.submitLookup(inputs)).rejects.toBeInstanceOf(NeweggValidationError);
  });

  it("fetches status via PUT and maps FINISHED", async () => {
    const { client, calls } = makeClient("ca", [
      {
        method: "PUT",
        pathPattern: paths.reportStatus,
        reply: () => ({ status: 200, body: STATUS_FINISHED }),
      },
    ]);
    const status = await client.catalog.lookupStatus("REQ123");
    expect(status.status).toBe("finished");
    expect(calls[0]?.method).toBe("PUT");
  });

  it("fetches a result page via PUT and parses matches", async () => {
    const { client, calls } = makeClient("ca", [
      {
        method: "PUT",
        pathPattern: paths.reportResult,
        reply: () => ({ status: 200, body: RESULT_PAGE }),
      },
    ]);
    const page = await client.catalog.lookupResult("REQ123", 1);
    expect(page.matches[0]?.neweggItemNumber).toBe("9SIA0060884598");
    expect(page.totalPageCount).toBe(1);
    expect(calls[0]?.bodyJson).toEqual({
      OperationType: "ItemLookupRequest",
      RequestBody: { RequestID: "REQ123", PageInfo: { PageIndex: 1, PageSize: 100 } },
    });
  });
});

// ---------------------------------------------------------------------------
// resolve() facade
// ---------------------------------------------------------------------------
describe("catalog.resolve", () => {
  it("resolves a neweggItemNumber input without any network call", async () => {
    const { client, calls } = makeClient("ca", []);
    const result = await client.catalog.resolve({ neweggItemNumber: "9SIA1" });
    expect(calls).toHaveLength(0);
    expect(result.requestId).toBeUndefined();
    expect(result.resolutions).toEqual([
      {
        input: { neweggItemNumber: "9SIA1" },
        found: true,
        matches: [{ neweggItemNumber: "9SIA1" }],
      },
    ]);
  });

  it("runs submit → poll (IN_PROGRESS then FINISHED) → result, mapping matches per input", async () => {
    let statusCalls = 0;
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: SUBMIT_OK }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportStatus,
        reply: () => ({
          status: 200,
          body: ++statusCalls === 1 ? STATUS_IN_PROGRESS : STATUS_FINISHED,
        }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportResult,
        reply: () => ({ status: 200, body: RESULT_PAGE }),
      },
    ]);
    const result = await client.catalog.resolve(
      [{ upc: "812674021181" }, { upc: "999999999999" }],
      { pollIntervalMs: 0, maxPollIntervalMs: 0 },
    );
    expect(result.requestId).toBe("REQ123");
    expect(statusCalls).toBe(2);
    const [hit, miss] = result.resolutions;
    expect(hit?.found).toBe(true);
    expect(hit?.matches[0]?.neweggItemNumber).toBe("9SIA0060884598");
    expect(miss?.found).toBe(false);
    expect(miss?.matches).toEqual([]);
  });

  it("throws CatalogLookupTimeoutError (carrying requestId) when the report never finishes", async () => {
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: SUBMIT_OK }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportStatus,
        reply: () => ({ status: 200, body: STATUS_IN_PROGRESS }),
      },
    ]);
    const err = await client.catalog
      .resolve(
        { upc: "812674021181" },
        { timeoutMs: 25, pollIntervalMs: 10, maxPollIntervalMs: 10 },
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(CatalogLookupTimeoutError);
    expect((err as CatalogLookupTimeoutError).requestId).toBe("REQ123");
    expect((err as CatalogLookupTimeoutError).retryable).toBe(true);
  });

  it("throws a non-retryable CatalogLookupTimeoutError when Newegg cancels the report", async () => {
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: SUBMIT_OK }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportStatus,
        reply: () => ({
          status: 200,
          body: {
            ResponseBody: { ResponseList: [{ RequestId: "REQ123", RequestStatus: "CANCELLED" }] },
          },
        }),
      },
    ]);
    const err = await client.catalog.resolve({ upc: "812674021181" }, { pollIntervalMs: 0 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CatalogLookupTimeoutError);
    expect((err as CatalogLookupTimeoutError).retryable).toBe(false);
  });

  it("pages through multi-page results", async () => {
    let resultCalls = 0;
    const pageOf = (pageIndex: number, itemNumber: string) => ({
      ResponseBody: {
        PageInfo: {
          TotalCount: "2",
          TotalPageCount: "2",
          PageIndex: String(pageIndex),
          PageSize: "100",
        },
        ItemList: [{ NeweggItemNumber: itemNumber, UPC: "812674021181" }],
      },
    });
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: SUBMIT_OK }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportStatus,
        reply: () => ({ status: 200, body: STATUS_FINISHED }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportResult,
        reply: () => {
          resultCalls += 1;
          return { status: 200, body: pageOf(resultCalls, resultCalls === 1 ? "9SIA1" : "9SIA2") };
        },
      },
    ]);
    const result = await client.catalog.resolve({ upc: "812674021181" }, { pollIntervalMs: 0 });
    expect(resultCalls).toBe(2);
    expect(result.resolutions[0]?.matches).toHaveLength(2);
  });

  it("ranks condition-bearing rows above condition-less pseudo-rows (live R-row trap)", async () => {
    // Live-observed shape (feed Z2XAN6RDVOKS failure): the lookup report lists an
    // R-suffixed refurb pseudo-row WITHOUT a Condition field FIRST, then the real row.
    // The creation feed rejects the R number, so the real row must surface as matches[0].
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: SUBMIT_OK }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportStatus,
        reply: () => ({ status: 200, body: STATUS_FINISHED }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportResult,
        reply: () => ({
          status: 200,
          body: {
            ResponseBody: {
              PageInfo: { TotalCount: 2, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
              ItemList: [
                { NeweggItemNumber: "20-250-259R", UPC: "619659198114" },
                { NeweggItemNumber: "20-250-259", UPC: "619659198114", Condition: "1" },
              ],
            },
          },
        }),
      },
    ]);
    const result = await client.catalog.resolve(
      { upc: "619659198114", condition: "new" },
      { pollIntervalMs: 0 },
    );
    const matches = result.resolutions[0]?.matches ?? [];
    // Both rows are kept (the pseudo-row can't be disproven), but ranked, not wire-ordered.
    expect(matches.map((m) => m.neweggItemNumber)).toEqual(["20-250-259", "20-250-259R"]);
  });

  it("keeps wire order among equally-ranked matches (stable sort)", async () => {
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: SUBMIT_OK }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportStatus,
        reply: () => ({ status: 200, body: STATUS_FINISHED }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportResult,
        reply: () => ({
          status: 200,
          body: {
            ResponseBody: {
              PageInfo: { TotalCount: 3, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
              ItemList: [
                { NeweggItemNumber: "7A20-147-900", UPC: "887276843674", Condition: "1" },
                { NeweggItemNumber: "20-147-900", UPC: "887276843674", Condition: "1" },
                { NeweggItemNumber: "20-147-900R", UPC: "887276843674" },
              ],
            },
          },
        }),
      },
    ]);
    const result = await client.catalog.resolve({ upc: "887276843674" }, { pollIntervalMs: 0 });
    expect(result.resolutions[0]?.matches.map((m) => m.neweggItemNumber)).toEqual([
      "7A20-147-900",
      "20-147-900",
      "20-147-900R",
    ]);
  });

  it("matches mpn inputs case-insensitively against result rows", async () => {
    const { client } = makeClient("ca", [
      {
        method: "POST",
        pathPattern: paths.reportSubmit,
        reply: () => ({ status: 200, body: SUBMIT_OK }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportStatus,
        reply: () => ({ status: 200, body: STATUS_FINISHED }),
      },
      {
        method: "PUT",
        pathPattern: paths.reportResult,
        reply: () => ({
          status: 200,
          body: {
            ResponseBody: {
              PageInfo: { TotalCount: 1, TotalPageCount: 1, PageIndex: 1, PageSize: 100 },
              ItemList: [
                {
                  NeweggItemNumber: "9SIA3",
                  ManufacturerName: "CORSAIR",
                  ManufacturerPartNumber: "cssd-f2000gbmp700mcs",
                },
              ],
            },
          },
        }),
      },
    ]);
    const result = await client.catalog.resolve(
      { manufacturer: "Corsair", manufacturerPartNumber: "CSSD-F2000GBMP700MCS" },
      { pollIntervalMs: 0 },
    );
    expect(result.resolutions[0]?.found).toBe(true);
  });
});
