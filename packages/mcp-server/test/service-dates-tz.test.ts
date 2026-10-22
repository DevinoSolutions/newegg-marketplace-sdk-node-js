import { describe, expect, it } from "vitest";
import type { MockRoute } from "@devino/newegg-marketplace-sdk/testing";
import { callTool, makeEnv, startHarness } from "./helpers.js";

/**
 * T-5962: the rma / refund / sbn list tools take the same date input as the orders tool: a
 * zone-less string is a Pacific wall clock and reaches Newegg unchanged, whatever the machine zone.
 */

const route = (method: string, pattern: RegExp, body: unknown = {}): MockRoute => ({
  method,
  pathPattern: pattern,
  reply: () => ({ status: 200, body }),
});

/** Depth-first lookup of the first value stored under `key` anywhere in a request body. */
function find(node: unknown, key: string): unknown {
  if (node === null || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  if (key in record) return record[key];
  for (const child of Object.values(record)) {
    const hit = find(child, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Runs `fn` with the process zone forced to `zone`, restoring it afterwards. */
async function withZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

interface Case {
  tool: string;
  method: string;
  path: RegExp;
  env?: ReturnType<typeof makeEnv>;
  /** Static tool arguments besides the dates. */
  args?: Record<string, unknown>;
  fromArg: string;
  toArg: string;
  fromKey: string;
  toKey: string;
}

const CASES: Case[] = [
  {
    tool: "newegg_rma_list",
    method: "PUT",
    path: /servicemgmt\/rma\/rmainfo/,
    fromArg: "dateFrom",
    toArg: "dateTo",
    fromKey: "RMADateFrom",
    toKey: "RMADateTo",
  },
  {
    tool: "newegg_refund_list",
    method: "PUT",
    path: /servicemgmt\/courtesyrefund\/info/,
    fromArg: "dateFrom",
    toArg: "dateTo",
    fromKey: "DateFrom",
    toKey: "DateTo",
  },
  {
    tool: "newegg_refund_status",
    method: "PUT",
    path: /servicemgmt\/courtesyrefund\/requeststatus/,
    args: { requestIds: ["00000000-0000-4000-8000-000000000001"] },
    fromArg: "dateFrom",
    toArg: "dateTo",
    fromKey: "RequestDateFrom",
    toKey: "RequestDateTo",
  },
  {
    tool: "newegg_sbn_shipments_list",
    method: "PUT",
    path: /sbnmgmt\/inboundshipment\/shipmentlist/,
    env: makeEnv({ NEWEGG_MARKETPLACE: "us" }),
    fromArg: "updatedFrom",
    toArg: "updatedTo",
    fromKey: "LastUpdateDateFrom",
    toKey: "LastUpdateDateTo",
  },
  {
    tool: "newegg_sbn_request_status",
    method: "PUT",
    path: /sbnmgmt\/inboundshipment\/shipmentstatus/,
    env: makeEnv({ NEWEGG_MARKETPLACE: "us" }),
    fromArg: "requestDateFrom",
    toArg: "requestDateTo",
    fromKey: "RequestDateFrom",
    toKey: "RequestDateTo",
  },
];

async function sentWindow(
  c: Case,
  dates: { from: string; to: string },
): Promise<{ from: unknown; to: unknown }> {
  const harness = await startHarness({
    ...(c.env ? { env: c.env } : {}),
    routes: [route(c.method, c.path)],
  });
  try {
    await callTool(harness.mcp, c.tool, {
      ...c.args,
      [c.fromArg]: dates.from,
      [c.toArg]: dates.to,
    });
    expect(harness.calls, c.tool).toHaveLength(1);
    const body = harness.calls[0]!.bodyJson;
    return { from: find(body, c.fromKey), to: find(body, c.toKey) };
  } finally {
    await harness.close();
  }
}

describe("rma / refund / sbn date input is Pacific wall clock, independent of the machine zone (T-5962)", () => {
  for (const c of CASES) {
    describe(c.tool, () => {
      it("sends a zone-less Pacific wall clock unchanged under a non-Pacific TZ", async () => {
        for (const zone of ["Asia/Tokyo", "Pacific/Auckland"]) {
          await withZone(zone, async () => {
            const sent = await sentWindow(c, {
              from: "2026-03-10 08:00:00",
              to: "2026-03-11 17:30:00",
            });
            expect(sent, `${c.tool} ${zone}`).toEqual({
              from: "2026-03-10 08:00:00",
              to: "2026-03-11 17:30:00",
            });
          });
        }
      });

      it("renders an instant with an offset in Pacific time under a non-Pacific TZ", async () => {
        await withZone("Asia/Tokyo", async () => {
          // 18:30Z on 2023-06-15 is 11:30:00 Pacific (PDT).
          const sent = await sentWindow(c, {
            from: "2023-06-15T20:30:00+02:00",
            to: "2023-06-15T18:30:00.000Z",
          });
          expect(sent).toEqual({ from: "2023-06-15 11:30:00", to: "2023-06-15 11:30:00" });
        });
      });

      it("expands a bare date to the Pacific day edges under a non-Pacific TZ", async () => {
        await withZone("Pacific/Auckland", async () => {
          const sent = await sentWindow(c, { from: "2026-03-10", to: "2026-03-10" });
          expect(sent).toEqual({ from: "2026-03-10 00:00:00", to: "2026-03-10 23:59:59" });
        });
      });
    });
  }
});
