import net from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNeweggMcpServer,
  loadMcpConfigFromEnv,
  McpConfigError,
  startHttpServer,
  type HttpServerHandle,
  type McpHttpConfig,
  type StartHttpServerOptions,
} from "../src/index.js";
import { makeEnv, makeMockClient, SENTINELS } from "./helpers.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/version.js";

// T-5670 (L6) session cap / idle TTL / oversize cut-off, T-5671 (L7) malformed Host,
// T-5672 (L8) 401 throttling and the plaintext-bind warning.

const config = loadMcpConfigFromEnv(makeEnv());
type Logged = { level: string; event: string; fields?: Record<string, unknown> };

function httpConfigWith(overrides: Partial<McpHttpConfig> = {}): McpHttpConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    bearerToken: SENTINELS.bearer,
    allowedOrigins: [],
    allowedHosts: [],
    ...overrides,
  };
}

let handle: HttpServerHandle | undefined;
afterEach(async () => {
  if (handle !== undefined) {
    await handle.close();
    handle = undefined;
  }
});

async function start(
  http: McpHttpConfig,
  extra: Partial<StartHttpServerOptions> = {},
): Promise<{ handle: HttpServerHandle; logged: Logged[] }> {
  const logged: Logged[] = [];
  handle = await startHttpServer({
    http,
    writesEnabled: false,
    createServer: () => createNeweggMcpServer({ config, client: makeMockClient([]).client }),
    logger: (level, event, fields) => logged.push({ level, event, fields }),
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    ...extra,
  });
  return { handle, logged };
}

interface RawResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  elapsedMs: number;
}

function rawRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers: Record<string, string | string[]>;
  body?: string;
}): Promise<RawResponse> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += String(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
            elapsedMs: Date.now() - started,
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const AUTH = { authorization: `Bearer ${SENTINELS.bearer}` };
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...AUTH,
};
const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "security-test", version: "0.0.0" },
  },
});

function initialize(port: number): Promise<RawResponse> {
  return rawRequest({ port, method: "POST", path: "/mcp", headers: MCP_HEADERS, body: INIT_BODY });
}

const sessionIdOf = (res: RawResponse): string => String(res.headers["mcp-session-id"] ?? "");

const LIST_BODY = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

function listTools(port: number, sessionId: string): Promise<RawResponse> {
  return rawRequest({
    port,
    method: "POST",
    path: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    body: LIST_BODY,
  });
}

describe("MCP HTTP sessions are bounded (T-5670 / L6)", () => {
  it("refuses session N+1 and accepts a new one once a session is closed", async () => {
    const { handle: h } = await start(httpConfigWith({ maxSessions: 2 }));
    const first = await initialize(h.port);
    const second = await initialize(h.port);
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await initialize(h.port);
    expect(third.status).toBe(503);
    expect(sessionIdOf(third)).toBe("");

    const closed = await rawRequest({
      port: h.port,
      method: "DELETE",
      path: "/mcp",
      headers: { ...AUTH, "mcp-session-id": sessionIdOf(first) },
    });
    expect(closed.status).toBe(200);
    const retry = await initialize(h.port);
    expect(retry.status).toBe(200);
  });

  it("does not let concurrent initializes overshoot the cap", async () => {
    const { handle: h } = await start(httpConfigWith({ maxSessions: 2 }));
    const results = await Promise.all(Array.from({ length: 6 }, () => initialize(h.port)));
    expect(results.filter((res) => res.status === 200)).toHaveLength(2);
    expect(results.filter((res) => res.status === 503)).toHaveLength(4);
  });

  it("expires an idle session", async () => {
    const { handle: h } = await start(httpConfigWith({ sessionIdleTtlSeconds: 0.3 }));
    const sessionId = sessionIdOf(await initialize(h.port));
    expect(sessionId).not.toBe("");
    expect((await listTools(h.port, sessionId)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await listTools(h.port, sessionId)).status).toBe(404);
  });

  it("keeps a session alive while it is being used", async () => {
    const { handle: h } = await start(httpConfigWith({ sessionIdleTtlSeconds: 0.6 }));
    const sessionId = sessionIdOf(await initialize(h.port));
    for (let round = 0; round < 4; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect((await listTools(h.port, sessionId)).status).toBe(200);
    }
  });
});

describe("an oversize request body is cut off, not drained (T-5670 / L6)", () => {
  it("answers 413 and closes the connection while the client is still uploading", async () => {
    const { handle: h } = await start(httpConfigWith());
    const total = 48 * 1024 * 1024;
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    const outcome = await new Promise<{ sent: number; received: string; closed: boolean }>(
      (resolve) => {
        const socket = net.connect(h.port, "127.0.0.1");
        let sent = 0;
        let received = "";
        let closed = false;
        const finish = (): void => {
          clearTimeout(timer);
          socket.destroy();
          resolve({ sent, received, closed });
        };
        const timer = setTimeout(finish, 8000);
        socket.on("data", (data) => {
          received += data.toString("latin1");
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          closed = true;
          finish();
        });
        const pump = (): void => {
          while (sent < total && !socket.destroyed) {
            sent += chunk.length;
            if (!socket.write(chunk)) {
              socket.once("drain", pump);
              return;
            }
          }
          if (!socket.destroyed) setTimeout(finish, 500);
        };
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nauthorization: Bearer ${SENTINELS.bearer}\r\n` +
            `content-type: application/json\r\ncontent-length: ${total}\r\n\r\n`,
          pump,
        );
      },
    );
    expect(outcome.closed).toBe(true);
    expect(outcome.sent).toBeLessThan(total);
    expect(outcome.received.startsWith("HTTP/1.1 413")).toBe(true);
  });
});

describe("a malformed Host header is a 400, not a 500 (T-5671 / L7)", () => {
  for (const host of ["a b", "exa mple.com", "a/b", "host:99999", "[::1", "a@b", "host:port"]) {
    it(`answers 400 without an error log for Host: ${host}`, async () => {
      const { handle: h, logged } = await start(httpConfigWith());
      for (const path of ["/mcp", "/healthz"]) {
        const res = await rawRequest({
          port: h.port,
          method: "GET",
          path,
          headers: { ...AUTH, host },
        });
        expect(res.status).toBe(400);
      }
      expect(logged.filter((line) => line.event === "http_request_failed")).toEqual([]);
    });
  }

  it("still serves a well-formed Host and still 403s a well-formed foreign Host", async () => {
    const { handle: h } = await start(httpConfigWith());
    const ok = await rawRequest({ port: h.port, method: "GET", path: "/healthz", headers: {} });
    expect(ok.status).toBe(200);
    const foreign = await rawRequest({
      port: h.port,
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, host: "evil.example" },
      body: INIT_BODY,
    });
    expect(foreign.status).toBe(403);
  });
});

describe("failed bearer attempts are throttled (T-5672 / L8)", () => {
  const bad = { authorization: "Bearer not-the-right-token-not-the-right-token" };

  it("slows repeated bad tokens from one client", async () => {
    const { handle: h } = await start(httpConfigWith(), {
      authBackoff: { baseMs: 60, maxMs: 400 },
    });
    const times: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await rawRequest({
        port: h.port,
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, ...bad },
        body: INIT_BODY,
      });
      expect(res.status).toBe(401);
      times.push(res.elapsedMs);
    }
    expect(times[0]).toBeGreaterThanOrEqual(45);
    expect(times[2]).toBeGreaterThanOrEqual(180);
    expect(times[3]).toBeGreaterThan(times[0] ?? 0);
  });

  it("does not let a good token erase the failure history of a shared address", async () => {
    const { handle: h } = await start(httpConfigWith(), {
      authBackoff: { baseMs: 60, maxMs: 400 },
    });
    const failOnce = () =>
      rawRequest({
        port: h.port,
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, ...bad },
        body: INIT_BODY,
      });
    // Four failures: the next one is delayed by min(400, 60 * 2^4) = 400 ms.
    for (let attempt = 0; attempt < 4; attempt += 1) await failOnce();

    // A legitimate client behind the same address succeeds, three times in a row.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await initialize(h.port)).status).toBe(200);
    }

    // At most one step was forgiven, so the guessing run is still slowed.
    const after = await failOnce();
    expect(after.status).toBe(401);
    expect(after.elapsedMs).toBeGreaterThanOrEqual(240);
  });

  it("answers 429 instead of queueing unlimited concurrent failures", async () => {
    const { handle: h } = await start(httpConfigWith(), {
      authBackoff: { baseMs: 100, maxMs: 400 },
    });
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        rawRequest({
          port: h.port,
          method: "POST",
          path: "/mcp",
          headers: { ...MCP_HEADERS, ...bad },
          body: INIT_BODY,
        }),
      ),
    );
    expect(results.some((res) => res.status === 429)).toBe(true);
    expect(results.every((res) => res.status === 401 || res.status === 429)).toBe(true);
  });
});

describe("a trivially weak bearer token is refused at startup (T-5672 / L8)", () => {
  it("refuses a long token with fewer than 12 distinct characters, without echoing it", async () => {
    const weak = "abcdefghijk".repeat(5);
    const error = await start(httpConfigWith({ bearerToken: weak })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("predictable");
    expect((error as Error).message).not.toContain(weak);
  });
});

describe("plaintext non-loopback binding is flagged (T-5672 / L8)", () => {
  it("warns when binding a non-loopback host without a declared TLS proxy", async () => {
    const { logged } = await start(httpConfigWith({ host: "0.0.0.0" }));
    const warning = logged.find((line) => line.event === "http_plaintext_non_loopback");
    expect(warning?.level).toBe("warn");
    expect(JSON.stringify(warning)).not.toContain(SENTINELS.bearer);
  });

  it("stays quiet when a TLS proxy is declared or the bind is loopback", async () => {
    const proxied = await start(httpConfigWith({ host: "0.0.0.0", behindTlsProxy: true }));
    expect(proxied.logged.filter((line) => line.event === "http_plaintext_non_loopback")).toEqual(
      [],
    );
    await handle?.close();
    handle = undefined;
    const loopback = await start(httpConfigWith());
    expect(loopback.logged.filter((line) => line.event === "http_plaintext_non_loopback")).toEqual(
      [],
    );
  });
});

describe("the HTTP transport needs a bearer token when writes are enabled (T-6211)", () => {
  const unauthenticated = { bearerToken: undefined };

  it("refuses to start on loopback with writes enabled and no token", async () => {
    const error = await start(httpConfigWith(unauthenticated), { writesEnabled: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("NEWEGG_MCP_HTTP_BEARER_TOKEN");
    expect(message).toContain("NEWEGG_MCP_ALLOW_WRITES");
    expect(message).toContain("openssl rand -hex 32");
  });

  it("refuses a blank-token loopback start with writes enabled on every loopback form", async () => {
    for (const host of ["localhost", "::1", "127.0.0.2"]) {
      await expect(
        start(httpConfigWith({ ...unauthenticated, host }), { writesEnabled: true }),
      ).rejects.toThrow(/NEWEGG_MCP_HTTP_BEARER_TOKEN/);
    }
  });

  it("starts on loopback with writes enabled and a token, and then enforces it", async () => {
    const { handle: started } = await start(httpConfigWith(), { writesEnabled: true });
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t-6211", version: "0.0.0" },
      },
    });
    const headers = {
      host: `127.0.0.1:${started.port}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const anonymous = await rawRequest({
      port: started.port,
      method: "POST",
      path: "/mcp",
      headers,
      body: initialize,
    });
    expect(anonymous.status).toBe(401);
  });

  it("fails closed when a JS caller omits writesEnabled, loopback included", async () => {
    const omitted = {
      http: httpConfigWith(unauthenticated),
      createServer: () => createNeweggMcpServer({ config, client: makeMockClient([]).client }),
      logger: () => undefined,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
    await expect(startHttpServer(omitted as unknown as StartHttpServerOptions)).rejects.toThrow(
      /NEWEGG_MCP_HTTP_BEARER_TOKEN/,
    );
  });

  it("still allows a read-only loopback start without a token", async () => {
    const { handle: started } = await start(httpConfigWith(unauthenticated), {
      writesEnabled: false,
    });
    expect(started.port).toBeGreaterThan(0);
  });

  it("does not affect stdio: writes without any HTTP token still load and build a server", () => {
    const writesConfig = loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_ALLOW_WRITES: "true" }));
    expect(writesConfig.allowWrites).toBe(true);
    expect(writesConfig.http.bearerToken).toBeUndefined();
    expect(() =>
      createNeweggMcpServer({ config: writesConfig, client: makeMockClient([]).client }),
    ).not.toThrow();
  });

  it("names the variables and prints no secret values in the refusal", async () => {
    const error = await start(httpConfigWith(unauthenticated), { writesEnabled: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    for (const secret of Object.values(SENTINELS)) {
      expect(message).not.toContain(secret);
    }
  });
});

// T-6214: /healthz and OPTIONS honour the Host allowlist, and a cross-site request with no
// Origin (a no-cors probe) is refused. An absent Origin stays allowed: real MCP clients send none.
describe("Host / Sec-Fetch-Site hardening (T-6214)", () => {
  it("answers /healthz 403 for a disallowed Host and never echoes it", async () => {
    const { handle: h } = await start(httpConfigWith());
    const res = await rawRequest({
      port: h.port,
      method: "GET",
      path: "/healthz",
      headers: { host: "evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("evil.example");
    expect(res.body).not.toContain(SERVER_NAME);
  });

  it("still serves /healthz for loopback and for an allowlisted Host", async () => {
    const { handle: h } = await start(httpConfigWith({ allowedHosts: ["mcp.example.com"] }));
    for (const host of [`127.0.0.1:${h.port}`, "mcp.example.com"]) {
      const res = await rawRequest({
        port: h.port,
        method: "GET",
        path: "/healthz",
        headers: { host },
      });
      expect(res.status).toBe(200);
    }
  });

  it("answers an OPTIONS preflight 403 for a disallowed Host", async () => {
    const { handle: h } = await start(httpConfigWith());
    const res = await rawRequest({
      port: h.port,
      method: "OPTIONS",
      path: "/mcp",
      headers: { host: "evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses POST /mcp with Sec-Fetch-Site cross-site and no Origin", async () => {
    const { handle: h } = await start(httpConfigWith());
    for (const site of ["cross-site", "same-site"]) {
      const res = await rawRequest({
        port: h.port,
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, "sec-fetch-site": site },
        body: INIT_BODY,
      });
      expect(res.status).toBe(403);
      expect(res.body).not.toContain(site);
    }
  });

  it("refuses /healthz with Sec-Fetch-Site cross-site and no Origin", async () => {
    const { handle: h } = await start(httpConfigWith());
    const res = await rawRequest({
      port: h.port,
      method: "GET",
      path: "/healthz",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("still allows no Origin with no Sec-Fetch-Site, none, or same-origin", async () => {
    const { handle: h } = await start(httpConfigWith());
    for (const extra of [
      {},
      { "sec-fetch-site": "none" },
      { "sec-fetch-site": "same-origin" },
    ] as Record<string, string>[]) {
      const res = await rawRequest({
        port: h.port,
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, ...extra },
        body: INIT_BODY,
      });
      expect(res.status).toBe(200);
    }
  });

  it("rejects the literal origins null and * in the allowed-origins env", () => {
    for (const bad of ["null", "*", "https://ok.example, NULL", " * "]) {
      expect(() => loadMcpConfigFromEnv(makeEnv({ NEWEGG_MCP_HTTP_ALLOWED_ORIGINS: bad }))).toThrow(
        McpConfigError,
      );
    }
    const ok = loadMcpConfigFromEnv(
      makeEnv({ NEWEGG_MCP_HTTP_ALLOWED_ORIGINS: "https://ok.example" }),
    );
    expect(ok.http.allowedOrigins).toEqual(["https://ok.example"]);
  });
});

// T-6215 (review nits from T-6214): the origin allowlist rules also bind embedders, and an
// allowlisted Origin is judged by the allowlist, whatever Sec-Fetch-Site says.
describe("allowed origins for embedders and fetch metadata (T-6215)", () => {
  it.each([["null"], ["*"], [" NuLl "], [" * "], ["https://ok.example", "*"]])(
    "startHttpServer refuses allowedOrigins %j",
    async (...origins) => {
      const error = await start(httpConfigWith({ allowedOrigins: origins })).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/concrete origins/);
    },
  );

  it("starts with concrete origins", async () => {
    const { handle: h } = await start(httpConfigWith({ allowedOrigins: ["https://ok.example"] }));
    expect(h.port).toBeGreaterThan(0);
  });

  it("refuses an OPTIONS preflight that is cross-site and has no Origin", async () => {
    const { handle: h } = await start(httpConfigWith());
    for (const site of ["cross-site", "same-site"]) {
      const res = await rawRequest({
        port: h.port,
        method: "OPTIONS",
        path: "/mcp",
        headers: { "sec-fetch-site": site },
      });
      expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("lets an allowlisted Origin through even when Sec-Fetch-Site is cross-site", async () => {
    const origin = "https://ok.example";
    const { handle: h } = await start(httpConfigWith({ allowedOrigins: [origin] }));
    const preflight = await rawRequest({
      port: h.port,
      method: "OPTIONS",
      path: "/mcp",
      headers: { origin, "sec-fetch-site": "cross-site" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
    const post = await rawRequest({
      port: h.port,
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, origin, "sec-fetch-site": "cross-site" },
      body: INIT_BODY,
    });
    expect(post.status).toBe(200);
  });

  it("still refuses an Origin that is not on the allowlist", async () => {
    const { handle: h } = await start(httpConfigWith({ allowedOrigins: ["https://ok.example"] }));
    const res = await rawRequest({
      port: h.port,
      method: "OPTIONS",
      path: "/mcp",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });
});

// T-6468 (review leftover from #70): a header sent twice must fail closed. Node joins duplicate
// Origin / Sec-Fetch-Site values with ", " (and an array form must never be read as its first
// element), so neither a good-then-bad nor a bad-then-good pair may slip past the guards.
describe("duplicate Origin and Sec-Fetch-Site headers fail closed (T-6468)", () => {
  const good = "https://ok.example";
  const dupOrigins: string[][] = [
    [good, "https://evil.example"],
    ["https://evil.example", good],
    [good, good],
  ];

  it.each(dupOrigins)("refuses POST /mcp with Origin sent twice (%s, %s)", async (first, second) => {
    const { handle: h } = await start(httpConfigWith({ allowedOrigins: [good] }));
    const res = await rawRequest({
      port: h.port,
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, origin: [first as string, second as string] },
      body: INIT_BODY,
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.body).not.toContain("evil.example");
  });

  it("refuses an OPTIONS preflight with Origin sent twice and sets no CORS headers", async () => {
    const { handle: h } = await start(httpConfigWith({ allowedOrigins: [good] }));
    const res = await rawRequest({
      port: h.port,
      method: "OPTIONS",
      path: "/mcp",
      headers: { origin: [good, "https://evil.example"] },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  const dupSites: string[][] = [
    ["same-origin", "cross-site"],
    ["cross-site", "same-origin"],
    ["none", "cross-site"],
    ["same-origin", "same-origin"],
  ];

  it.each(dupSites)(
    "refuses POST /mcp with no Origin and Sec-Fetch-Site sent twice (%s, %s)",
    async (first, second) => {
      const { handle: h } = await start(httpConfigWith());
      const res = await rawRequest({
        port: h.port,
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, "sec-fetch-site": [first as string, second as string] },
        body: INIT_BODY,
      });
      expect(res.status).toBe(403);
    },
  );

  it("refuses /healthz with no Origin and Sec-Fetch-Site sent twice", async () => {
    const { handle: h } = await start(httpConfigWith());
    const res = await rawRequest({
      port: h.port,
      method: "GET",
      path: "/healthz",
      headers: { "sec-fetch-site": ["same-origin", "cross-site"] },
    });
    expect(res.status).toBe(403);
  });
});
