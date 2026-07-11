/**
 * Shared test harness. Tests drive the server end-to-end through the REAL MCP SDK:
 * `InMemoryTransport.createLinkedPair()` + a `Client`, with the SDK's mock fetch wired into a
 * real `NeweggClient` injected via `createNeweggMcpServer({ client })`.
 *
 * Credentials are obvious sentinels so leak assertions are trivial.
 */
import { createNeweggClient } from "@devino/newegg-marketplace-sdk";
import type { NeweggClient, NeweggMarketplace } from "@devino/newegg-marketplace-sdk";
import {
  createMockFetch,
  type MockRoute,
  type RecordedCall,
} from "@devino/newegg-marketplace-sdk/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createNeweggMcpServer,
  loadMcpConfigFromEnv,
  InMemoryPreviewStore,
  type Logger,
  type PreviewStore,
} from "../src/index.js";

export const SENTINELS = {
  sellerId: "TEST-SELLER-SENTINEL",
  apiKey: "TEST-APIKEY-SENTINEL-32CHARS-XXXX",
  secretKey: "TEST-SECRET-SENTINEL",
  bearer: "TEST-BEARER-SENTINEL-TOKEN-XYZ",
} as const;

export type FakeEnv = Record<string, string | undefined>;

export function makeEnv(overrides: FakeEnv = {}): FakeEnv {
  return {
    NEWEGG_SELLER_ID: SENTINELS.sellerId,
    NEWEGG_API_KEY: SENTINELS.apiKey,
    NEWEGG_SECRET_KEY: SENTINELS.secretKey,
    NEWEGG_MARKETPLACE: "ca",
    ...overrides,
  };
}

export function makeMockClient(
  routes: MockRoute[],
  marketplace: NeweggMarketplace = "ca",
): { client: NeweggClient; calls: RecordedCall[] } {
  const { fetch, calls } = createMockFetch(routes);
  const client = createNeweggClient({
    sellerId: SENTINELS.sellerId,
    apiKey: SENTINELS.apiKey,
    secretKey: SENTINELS.secretKey,
    marketplace,
    fetch,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });
  return { client, calls };
}

export interface HarnessOptions {
  env?: FakeEnv;
  routes?: MockRoute[];
  client?: NeweggClient;
  previewStore?: PreviewStore;
  now?: () => Date;
  logger?: Logger;
}

export interface Harness {
  mcp: Client;
  calls: RecordedCall[];
  previewStore: PreviewStore;
  close: () => Promise<void>;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const config = loadMcpConfigFromEnv(opts.env ?? makeEnv());
  const mock = opts.client
    ? { client: opts.client, calls: [] as RecordedCall[] }
    : makeMockClient(opts.routes ?? [], config.marketplace);
  const previewStore = opts.previewStore ?? new InMemoryPreviewStore(opts.now);
  const instance = createNeweggMcpServer({
    config,
    client: mock.client,
    previewStore,
    now: opts.now,
    logger: opts.logger,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([mcp.connect(clientTransport), instance.server.connect(serverTransport)]);
  return {
    mcp,
    calls: mock.calls,
    previewStore,
    close: async () => {
      await mcp.close();
      await instance.close();
    },
  };
}

interface RawToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ParsedToolResult {
  isError: boolean;
  structuredContent: Record<string, unknown> | undefined;
  text: string;
  json: Record<string, unknown>;
}

/** Calls a tool and parses the text-content fallback as JSON. */
export async function callTool(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ParsedToolResult> {
  const res = (await mcp.callTool({ name, arguments: args })) as RawToolResult;
  const textItem = (res.content ?? []).find((item) => item.type === "text");
  const text = textItem?.text ?? "";
  let json: Record<string, unknown> = {};
  if (text !== "") {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // SDK schema-validation failures return a plain-string message, not JSON.
      json = {};
    }
  }
  return {
    isError: res.isError === true,
    structuredContent: res.structuredContent,
    text,
    json,
  };
}

// ---------------------------------------------------------------------------
// CA wire route builders (paths/response shapes proven by the SDK's own tests)
// ---------------------------------------------------------------------------
export const CA_PATHS = {
  inventoryList: /contentmgmt\/item\/inventorylist/,
  inventoryAndPrice: /contentmgmt\/item\/inventoryandprice/,
  feedSubmit: "datafeedmgmt/feeds/submitfeed",
  feedStatus: "datafeedmgmt/feeds/status",
  feedResult: "datafeedmgmt/feeds/result/",
  serviceStatus: "servicestatus",
} as const;

export function inventoryListRoute(quantityBySku: Record<string, number> = {}): MockRoute {
  return {
    method: "POST",
    pathPattern: CA_PATHS.inventoryList,
    reply: (req) => {
      const values = (req.bodyJson as { Values?: string[] }).Values ?? [];
      return {
        status: 200,
        body: {
          IsSuccess: true,
          ResponseBody: {
            ItemList: values.map((value) => ({
              SellerPartNumber: value,
              Active: "1",
              FulfillmentOption: "0",
              AvailableQuantity: quantityBySku[value] ?? 0,
            })),
            TotalCount: values.length,
          },
        },
      };
    },
  };
}

export function inventoryAndPriceRoute(): MockRoute {
  return {
    method: "PUT",
    pathPattern: CA_PATHS.inventoryAndPrice,
    reply: () => ({ status: 200, body: {} }),
  };
}

export function feedSubmitBody(requestId: string, status = "SUBMITTED"): unknown {
  return {
    IsSuccess: true,
    OperationType: "SubmitFeedResponse",
    ResponseBody: {
      ResponseList: [
        {
          RequestDate: "2/22/2012 17:24:35",
          RequestId: requestId,
          RequestStatus: status,
          RequestType: "INVENTORY_AND_PRICE_DATA",
        },
      ],
    },
    SellerID: "A006",
  };
}

export function feedSubmitRoute(requestId = "REQ12345"): MockRoute {
  return {
    method: "POST",
    pathPattern: CA_PATHS.feedSubmit,
    reply: () => ({ status: 200, body: feedSubmitBody(requestId) }),
  };
}

export function feedStatusBody(requestId: string, status: string): unknown {
  return {
    ResponseBody: {
      ResponseList: [
        {
          RequestId: requestId,
          RequestStatus: status,
          RequestType: "INVENTORY_AND_PRICE_DATA",
          RequestDate: "2/22/2012 17:24:35",
        },
      ],
    },
  };
}

export function feedStatusRoute(requestId: string, status: string): MockRoute {
  return {
    method: "PUT",
    pathPattern: CA_PATHS.feedStatus,
    reply: () => ({ status: 200, body: feedStatusBody(requestId, status) }),
  };
}

export function feedResultBody(
  records: Array<{ sku: string; error: string }>,
  summary = { processed: 3, succeeded: 1, failed: 2 },
): unknown {
  return {
    NeweggEnvelope: {
      Header: { DocumentVersion: "1.0" },
      MessageType: "ProcessingReport",
      Message: {
        ProcessingReport: {
          ProcessingSummary: {
            ProcessedCount: String(summary.processed),
            SuccessCount: String(summary.succeeded),
            WithErrorCount: String(summary.failed),
          },
          Result: records.map((record) => ({
            AdditionalInfo: { SellerPartNumber: record.sku },
            ErrorList: { ErrorDescription: record.error },
          })),
        },
      },
    },
  };
}

export function feedResultRoute(body: unknown): MockRoute {
  return {
    method: "GET",
    pathPattern: CA_PATHS.feedResult,
    reply: () => ({ status: 200, body }),
  };
}

export function serviceStatusRoute(statusValue: "0" | "1", message?: string): MockRoute {
  return {
    method: "GET",
    pathPattern: CA_PATHS.serviceStatus,
    reply: () => ({
      status: 200,
      body: {
        NeweggAPIResponse: {
          IsSuccess: "true",
          OperationType: "GetServiceStatus",
          SellerID: "A006",
          ResponseBody: {
            Status: statusValue,
            Timestamp: "2/15/2012 2:50:38",
            ...(message !== undefined ? { Message: message } : {}),
          },
        },
      },
    }),
  };
}
