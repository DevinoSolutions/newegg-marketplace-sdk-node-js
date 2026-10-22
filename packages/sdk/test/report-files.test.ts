import net from "node:net";
import { describe, expect, it } from "vitest";
import { NeweggApiError } from "../src/errors/index.js";
import { parseDelimited, normalizeHeader } from "../src/reportmgmt/csv.js";
import { downloadViaFtp } from "../src/reportmgmt/ftp.js";
import {
  describeReportFile,
  findReportFileUrl,
  redactUrlCredentials,
  sanitizeRaw,
} from "../src/reportmgmt/redact.js";
import { extractZip, looksLikeZip } from "../src/reportmgmt/zip.js";
import { buildZip } from "./helpers.js";

describe("parseDelimited", () => {
  it("parses CSV with quoted fields, embedded newlines/commas and escaped quotes", () => {
    const rows = parseDelimited('a,b,c\r\n1,"x,\ny","say ""hi"""\r\n\r\n2,,\r\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "x,\ny", 'say "hi"'],
      ["2", "", ""],
    ]);
  });

  it("detects tab-delimited TXT and strips a BOM", () => {
    const rows = parseDelimited("﻿Seller Part #\tNE Item #\nA1\t9SI1\n");
    expect(rows).toEqual([
      ["Seller Part #", "NE Item #"],
      ["A1", "9SI1"],
    ]);
  });

  it("normalizes headers", () => {
    expect(normalizeHeader("Seller Part #")).toBe("sellerpartnumber");
    expect(normalizeHeader(" NE Item # ")).toBe("neitemnumber");
    expect(normalizeHeader("Support MSRP for all seller")).toBe("supportmsrpforallseller");
    expect(normalizeHeader("Checkout MAP")).toBe("checkoutmap");
  });
});

describe("zip extraction", () => {
  it("reads stored and deflated entries and detects a zip", () => {
    const zip = buildZip([
      { name: "a.csv", data: "h\n1\n", method: 0 },
      { name: "b.csv", data: "h\n2\n3\n", method: 8 },
    ]);
    expect(looksLikeZip(zip)).toBe(true);
    expect(looksLikeZip(Buffer.from("h\n1\n"))).toBe(false);
    const entries = extractZip(zip, 1024);
    expect(entries.map((e) => e.name)).toEqual(["a.csv", "b.csv"]);
    expect(Buffer.from(entries[1]?.data ?? new Uint8Array()).toString("utf8")).toBe("h\n2\n3\n");
  });

  it("rejects garbage and enforces the uncompressed size cap", () => {
    expect(() => extractZip(Buffer.from("not a zip at all, definitely"), 1024)).toThrowError(
      NeweggApiError,
    );
    const zip = buildZip([{ name: "big.csv", data: "x".repeat(5000), method: 8 }]);
    expect(() => extractZip(zip, 1000)).toThrowError(/zip/i);
  });
});

describe("report file URL redaction", () => {
  const URL_SECRET = "ftp://APIuser:Pa55word@ftp03.newegg.com/InternationalInventoryReport_X1.zip";

  it("redacts user:password@ in free text and deep structures", () => {
    expect(redactUrlCredentials(`failed ${URL_SECRET} now`)).toBe(
      "failed ftp://***@ftp03.newegg.com/InternationalInventoryReport_X1.zip now",
    );
    const cleaned = sanitizeRaw({
      NeweggAPIResponse: { ResponseBody: { ReportFileURL: URL_SECRET, list: [URL_SECRET, 1] } },
    });
    expect(JSON.stringify(cleaned)).not.toContain("Pa55word");
    expect(JSON.stringify(cleaned)).toContain("ftp://***@ftp03.newegg.com");
  });

  it("finds the URL in wrapped and unwrapped bodies and describes it without credentials", () => {
    expect(
      findReportFileUrl({ NeweggAPIResponse: { ResponseBody: { ReportFileURL: URL_SECRET } } }),
    ).toBe(URL_SECRET);
    expect(findReportFileUrl({ ResponseBody: { ReportFileURL: URL_SECRET } })).toBe(URL_SECRET);
    expect(findReportFileUrl({ ResponseBody: {} })).toBeUndefined();
    const location = describeReportFile(URL_SECRET);
    expect(location?.host).toBe("ftp03.newegg.com");
    expect(location?.fileName).toBe("InternationalInventoryReport_X1.zip");
    expect(describeReportFile("not a url")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FTP downloader against a throw-away local FTP server
// ---------------------------------------------------------------------------
interface FakeFtp {
  port: number;
  commands: string[];
  close(): Promise<void>;
}

async function startFakeFtp(
  files: Record<string, Buffer>,
  options: { rejectPass?: boolean } = {},
): Promise<FakeFtp> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((control) => {
    sockets.add(control);
    control.setEncoding("latin1");
    control.write("220 fake ftp ready\r\n");
    let dataServer: net.Server | undefined;
    let dataSocketReady: Promise<net.Socket> | undefined;
    let buffer = "";
    control.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
        // Record command verbs only - never the argument (it may be a password).
        commands.push(line.split(" ")[0] ?? "");
        const [verb, ...rest] = line.split(" ");
        const arg = rest.join(" ");
        if (verb === "USER") control.write("331 password please\r\n");
        else if (verb === "PASS") {
          control.write(options.rejectPass ? "530 login incorrect\r\n" : "230 ok\r\n");
        } else if (verb === "TYPE") control.write("200 binary\r\n");
        else if (verb === "SIZE") {
          const sized = files[arg];
          control.write(sized ? `213 ${sized.length}\r\n` : "550 no such file\r\n");
        } else if (verb === "PASV") {
          dataServer = net.createServer();
          dataSocketReady = new Promise((resolve) => {
            dataServer?.once("connection", (socket) => {
              sockets.add(socket);
              resolve(socket);
            });
          });
          dataServer.listen(0, "127.0.0.1", () => {
            const port = (dataServer?.address() as net.AddressInfo).port;
            // 192,0,2,1 is deliberately WRONG: the client must connect to the control peer.
            control.write(`227 Entering Passive Mode (192,0,2,1,${port >> 8},${port & 255})\r\n`);
          });
        } else if (verb === "RETR") {
          const file = files[arg];
          if (!file) {
            control.write("550 no such file\r\n");
          } else {
            control.write("150 opening\r\n");
            void dataSocketReady?.then((socket) => {
              socket.end(file, () => {
                control.write("226 done\r\n");
                dataServer?.close();
              });
            });
          }
        } else if (verb === "QUIT") control.end("221 bye\r\n");
      }
    });
    control.on("close", () => sockets.delete(control));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const ANY_HOST = /.*/;

describe("downloadViaFtp", () => {
  it("logs in, retrieves a binary file over passive mode and returns its bytes", async () => {
    const payload = Buffer.from("Seller Part #,NE Item #\nA1,9SI1\n");
    const ftp = await startFakeFtp({ "report.csv": payload });
    try {
      const bytes = await downloadViaFtp(`ftp://user:s3cret@127.0.0.1:${ftp.port}/report.csv`, {
        maxBytes: 1024,
        timeoutMs: 5000,
        allowedHost: ANY_HOST,
        allowedPorts: [ftp.port],
      });
      expect(Buffer.from(bytes).toString("utf8")).toBe(payload.toString("utf8"));
      expect(ftp.commands).toEqual(
        expect.arrayContaining(["USER", "PASS", "TYPE", "PASV", "RETR"]),
      );
    } finally {
      await ftp.close();
    }
  });

  it("refuses hosts outside *.newegg.com by default, before any connection", async () => {
    const error = await downloadViaFtp("ftp://user:pw@127.0.0.1:2121/x.csv", {
      maxBytes: 1024,
      timeoutMs: 1000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(JSON.stringify(error)).not.toContain("pw");
  });

  it("rejects non-ftp URLs", async () => {
    await expect(
      downloadViaFtp("https://ftp03.newegg.com/x.csv", { maxBytes: 1, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(NeweggApiError);
  });

  it("maps a login failure to a NeweggApiError that never contains the credentials", async () => {
    const ftp = await startFakeFtp({}, { rejectPass: true });
    try {
      const error = await downloadViaFtp(`ftp://user:topsecretpw@127.0.0.1:${ftp.port}/x.csv`, {
        maxBytes: 1024,
        timeoutMs: 5000,
        allowedHost: ANY_HOST,
        allowedPorts: [ftp.port],
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NeweggApiError);
      expect(JSON.stringify(error)).not.toContain("topsecretpw");
      expect((error as Error).message).toMatch(/login/);
    } finally {
      await ftp.close();
    }
  });

  it("aborts when the file exceeds maxBytes", async () => {
    const ftp = await startFakeFtp({ "big.csv": Buffer.alloc(5000, 97) });
    try {
      await expect(
        downloadViaFtp(`ftp://u:p@127.0.0.1:${ftp.port}/big.csv`, {
          maxBytes: 1000,
          timeoutMs: 5000,
          allowedHost: ANY_HOST,
          allowedPorts: [ftp.port],
        }),
      ).rejects.toThrowError(/size limit/);
    } finally {
      await ftp.close();
    }
  });

  it("reports a missing file (550) as a download failure", async () => {
    const ftp = await startFakeFtp({});
    try {
      await expect(
        downloadViaFtp(`ftp://u:p@127.0.0.1:${ftp.port}/nope.csv`, {
          maxBytes: 1000,
          timeoutMs: 5000,
          allowedHost: ANY_HOST,
          allowedPorts: [ftp.port],
        }),
      ).rejects.toThrowError(/retrieval/);
    } finally {
      await ftp.close();
    }
  });

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadViaFtp("ftp://u:p@127.0.0.1:1/x.csv", {
        maxBytes: 10,
        timeoutMs: 1000,
        allowedHost: ANY_HOST,
        allowedPorts: [1],
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });
});
