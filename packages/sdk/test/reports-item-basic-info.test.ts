import { describe, expect, it } from "vitest";
import { NeweggValidationError, ReportTimeoutError } from "../src/errors/index.js";
import { buildZip, makeClient, paths } from "./helpers.js";

/**
 * Item Basic Information report (contracts §17.8): request, file download and column mapping.
 * Fixtures are fictional placeholders; the column set mirrors the live CAN file (2026-10-10).
 */
const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 2 };

const SUBMIT_OK = {
  IsSuccess: true,
  OperationType: "ItemBasicInfoReportResponse",
  SellerID: "A006",
  ResponseBody: {
    ResponseList: [
      {
        RequestId: "REQ1",
        RequestType: "ITEM_BASIC_INFO_REPORT",
        RequestDate: "07/12/2014 11:34:57",
        RequestStatus: "SUBMITTED",
      },
    ],
  },
};

const STATUS = (status: string) => ({
  IsSuccess: true,
  OperationType: "GetReportStatusResponse",
  ResponseBody: {
    ResponseList: [{ RequestId: "REQ1", RequestType: "X", RequestStatus: status, TotalCount: 2 }],
  },
});

const SECRET_URL =
  "ftp://APIuser123:Sup3rSecretPw@mktpftpreport.newegg.com/ApiItemBaseInfoReport_REQ1.zip";

function fileRoutes(status = "FINISHED") {
  return [
    {
      method: "POST",
      pathPattern: paths.reportSubmit,
      reply: () => ({ status: 200, body: SUBMIT_OK }),
    },
    {
      method: "PUT",
      pathPattern: paths.reportStatus,
      reply: () => ({ status: 200, body: STATUS(status) }),
    },
    {
      method: "PUT",
      pathPattern: paths.reportResult,
      reply: () => ({
        status: 200,
        // Live-verified (CAN): the URL sits under NeweggAPIResponse.ResponseBody; the top is empty.
        body: {
          NeweggAPIResponse: {
            IsSuccess: "true",
            sellerID: "A006",
            OperationType: "ItemBasicInfoReportResponse",
            ResponseBody: {
              RequestID: "REQ1",
              RequestType: "ITEM_BASIC_INFO_REPORT",
              RequestDate: "10/10/2026 11:00:00",
              ReportFileURL: SECRET_URL,
            },
            Memo: "",
          },
        },
      }),
    },
  ];
}

const ITEM_CSV =
  "Seller Part #,NE Item #,Manufacturer Part #,UPC,Status,Wesite Short Title,Industry,Subcategory," +
  "Bullet Description,Item Length,Item Width,Item Height,Item Weight,Item Image,Date Created," +
  "Platform,Item Group ID,Custom Variety 1 Name,Custom Variety 1 Value,Custom Variety 2 Name," +
  "Custom Variety 2 Value,Surprise Column\n" +
  'SKU-1,9SIEXAMPLE0001,MPN-1,012345678905,Active,"Example Widget, 2 pack",Computer Hardware,' +
  '"Widgets","Line one\nLine two",12.5,3,4.25,0.8,"https://img.example.test/a.jpg,https://img.example.test/b.jpg",' +
  "03/07/2026,CAN,123456789,Color,Blue,Size,Large,extra value\n" +
  "SKU-2,9SIEXAMPLE0002,MPN-2,,Inactive,Other Widget,Computer Hardware,Widgets,,,,,,,10/01/2025,CAN,,,,,,\n";

describe("reports.itemBasicInfo", () => {
  it("builds the same submit body (no version query) on every platform and prefix", async () => {
    for (const [marketplace, prefix] of [
      ["us", "/marketplace/reportmgmt/"],
      ["b2b", "/marketplace/b2b/reportmgmt/"],
      ["ca", "/marketplace/can/reportmgmt/"],
    ] as const) {
      const { client, calls } = makeClient(marketplace, fileRoutes());
      await client.reports.itemBasicInfo.submit({ status: "active", fileType: "txt" });
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url.pathname).toBe(`${prefix}report/submitrequest`);
      expect(calls[0]?.url.searchParams.has("version")).toBe(false);
      expect(calls[0]?.bodyJson).toEqual({
        OperationType: "ItemBasicInfoReportRequest",
        RequestBody: {
          ItemBasicInfoReportCriteria: {
            RequestType: "ITEM_BASIC_INFO_REPORT",
            Status: "1",
            FileType: "TXT",
          },
        },
      });
    }
  });

  it("result() exposes host + file name but never the credential-bearing URL", async () => {
    const { client, calls } = makeClient("ca", fileRoutes());
    const info = await client.reports.itemBasicInfo.result("REQ1", { includeRaw: true });
    expect(info).toMatchObject({
      available: true,
      host: "mktpftpreport.newegg.com",
      fileName: "ApiItemBaseInfoReport_REQ1.zip",
    });
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("Sup3rSecretPw");
    expect(serialized).not.toContain("APIuser123");
    expect(calls[0]?.bodyJson).toEqual({
      OperationType: "ItemBasicInfoReportRequest",
      RequestBody: { RequestID: "REQ1" },
    });
  });

  it("downloads a zipped CSV and maps every column (quoted commas/newlines, typo header)", async () => {
    const zip = buildZip([{ name: "ApiItemBaseInfoReport_REQ1.csv", data: ITEM_CSV }]);
    const { client } = makeClient("ca", fileRoutes(), { reportFileDownloader: async () => zip });
    const report = await client.reports.itemBasicInfo.waitForResult({}, FAST);
    expect(report).toMatchObject({ totalRows: 2, truncated: false, fileCount: 1 });
    expect(report.rows[0]).toEqual({
      sellerPartNumber: "SKU-1",
      neweggItemNumber: "9SIEXAMPLE0001",
      manufacturerPartNumber: "MPN-1",
      upc: "012345678905",
      status: "Active",
      active: true,
      title: "Example Widget, 2 pack",
      industry: "Computer Hardware",
      subcategory: "Widgets",
      bulletDescription: "Line one\nLine two",
      itemLength: 12.5,
      itemWidth: 3,
      itemHeight: 4.25,
      itemWeight: 0.8,
      imageUrls: ["https://img.example.test/a.jpg", "https://img.example.test/b.jpg"],
      dateCreated: "2026-03-07",
      platform: "CAN",
      itemGroupId: "123456789",
      varieties: [
        { name: "Color", value: "Blue" },
        { name: "Size", value: "Large" },
      ],
      extra: { surprisecolumn: "extra value" },
    });
    // The second row has no UPC / group / varieties; blank cells never become empty strings.
    expect(report.rows[1]).toEqual({
      sellerPartNumber: "SKU-2",
      neweggItemNumber: "9SIEXAMPLE0002",
      manufacturerPartNumber: "MPN-2",
      status: "Inactive",
      active: false,
      title: "Other Widget",
      industry: "Computer Hardware",
      subcategory: "Widgets",
      dateCreated: "2025-10-01",
      platform: "CAN",
    });
    expect(JSON.stringify(report)).not.toContain("Sup3rSecretPw");
  });

  it("accepts the corrected 'Website Short Title' header and an empty report", async () => {
    const csv =
      "Seller Part #,NE Item #,Status,Website Short Title\nSKU-1,9SIX,Active,Fixed Title\n";
    const { client } = makeClient("ca", fileRoutes(), {
      reportFileDownloader: async () => Buffer.from(csv),
    });
    expect((await client.reports.itemBasicInfo.download("REQ1")).rows[0]?.title).toBe(
      "Fixed Title",
    );
    const { client: empty } = makeClient("ca", fileRoutes(), {
      reportFileDownloader: async () => Buffer.from("Seller Part #,NE Item #,Status\n"),
    });
    expect(await empty.reports.itemBasicInfo.download("REQ1")).toMatchObject({
      rows: [],
      totalRows: 0,
    });
  });

  it("throws ReportTimeoutError carrying the requestId when the report is slow", async () => {
    const { client } = makeClient("ca", fileRoutes("IN_PROGRESS"));
    const error = await client.reports.itemBasicInfo
      .waitForResult({}, { ...FAST, timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportTimeoutError);
    expect((error as ReportTimeoutError).requestId).toBe("REQ1");
  });

  it("rejects a bad status before any request", async () => {
    const { client, calls } = makeClient("ca", []);
    await expect(
      client.reports.itemBasicInfo.submit({ status: "everything" as never }),
    ).rejects.toBeInstanceOf(NeweggValidationError);
    expect(calls).toHaveLength(0);
  });
});
