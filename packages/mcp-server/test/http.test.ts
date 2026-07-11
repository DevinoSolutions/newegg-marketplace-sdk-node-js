import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createNeweggMcpServer,
  loadMcpConfigFromEnv,
  startHttpServer,
  type HttpServerHandle,
  type McpHttpConfig,
} from "../src/index.js";
import { makeEnv, makeMockClient, SENTINELS } from "./helpers.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/version.js";

const config = loadMcpConfigFromEnv(makeEnv());

function httpConfigWith(overrides: Partial<McpHttpConfig>): McpHttpConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    bearerToken: SENTINELS.bearer,
    allowedOrigins: [],
    allowedHosts: [],
    ...overrides,
  };
}

function start(http: McpHttpConfig): Promise<HttpServerHandle> {
  return startHttpServer({
    http,
    createServer: () => createNeweggMcpServer({ config, client: makeMockClient([]).client }),
    logger: () => undefined,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += String(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  if (handle !== undefined) {
    await handle.close();
    handle = undefined;
  }
});

describe("streamable HTTP transport", () => {
  it("refuses to bind a non-loopback host without a bearer token", async () => {
    await expect(
      start(httpConfigWith({ host: "0.0.0.0", bearerToken: undefined })),
    ).rejects.toThrow(/non-loopback/);
  });

  it("accepts an authenticated MCP client and lists tools", async () => {
    handle = await start(httpConfigWith({}));
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${SENTINELS.bearer}` } },
      },
    );
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()) as { tools: Array<{ name: string }> };
      expect(tools.tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("rejects a client with no bearer token (401)", async () => {
    handle = await start(httpConfigWith({}));
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    );
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("rejects a client with the wrong bearer token (401)", async () => {
    handle = await start(httpConfigWith({}));
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        requestInit: { headers: { Authorization: "Bearer WRONG-TOKEN" } },
      },
    );
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("serves /healthz without auth and echoes no secrets", async () => {
    handle = await start(httpConfigWith({}));
    const res = await rawRequest({
      port: handle.port,
      method: "GET",
      path: "/healthz",
      headers: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { status: string; server: string };
    expect(parsed.status).toBe("ok");
    expect(parsed.server).toBe(SERVER_NAME);
    for (const secret of [
      SENTINELS.sellerId,
      SENTINELS.apiKey,
      SENTINELS.secretKey,
      SENTINELS.bearer,
    ]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("rejects a disallowed Origin with 403", async () => {
    handle = await start(httpConfigWith({}));
    const res = await rawRequest({
      port: handle.port,
      method: "POST",
      path: "/mcp",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SENTINELS.bearer}`,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a spoofed Host header with 403", async () => {
    handle = await start(httpConfigWith({}));
    const res = await rawRequest({
      port: handle.port,
      method: "POST",
      path: "/mcp",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SENTINELS.bearer}`,
        host: "evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a body larger than the 4 MB cap with 413", async () => {
    handle = await start(httpConfigWith({}));
    const big = "x".repeat(4 * 1024 * 1024 + 16);
    const res = await rawRequest({
      port: handle.port,
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", authorization: `Bearer ${SENTINELS.bearer}` },
      body: big,
    });
    expect(res.status).toBe(413);
  });
});
