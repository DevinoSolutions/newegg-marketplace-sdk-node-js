import { describe, expect, it } from "vitest";
import { callTool, startHarness } from "./helpers.js";

const FTP_URL = "ftp://LabelUser:Pa55word@ftp03.newegg.com/x.pdf";
const HTTPS_URL = "https://LabelUser:Pa55word@files.newegg.com/x.pdf";

function bodyFor(format: "object" | "array" | "xml" | "text", url: string): string {
  const message = `Label ready at ${url} - download it`;
  switch (format) {
    case "object":
      return JSON.stringify({ Code: "CT002", Message: message });
    case "array":
      return JSON.stringify([{ Code: "CT002", Message: message }]);
    case "xml":
      return `<?xml version="1.0"?><Error><Code>CT002</Code><Message>${message}</Message></Error>`;
    case "text":
      return message;
  }
}

describe("MCP tool errors never carry URL credentials from upstream error bodies", () => {
  for (const format of ["object", "array", "xml", "text"] as const) {
    for (const url of [FTP_URL, HTTPS_URL]) {
      it(`${format} body with ${url.split(":")[0]} URL`, async () => {
        const logged: unknown[] = [];
        const harness = await startHarness({
          logger: (...args: unknown[]) => logged.push(args),
          routes: [
            {
              method: "GET",
              pathPattern: "servicestatus",
              reply: () => ({ status: 400, body: bodyFor(format, url) }),
            },
          ],
        });
        try {
          const res = await callTool(harness.mcp, "newegg_service_status", {});
          expect(res.isError).toBe(true);
          for (const text of [res.text, JSON.stringify(res.json), JSON.stringify(logged)]) {
            expect(text).not.toContain("Pa55word");
            expect(text).not.toContain("LabelUser");
          }
          expect(res.json.errorCode).toBe("api");
        } finally {
          await harness.close();
        }
      });
    }
  }
});
