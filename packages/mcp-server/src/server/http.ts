/**
 * Streamable HTTP transport on a plain `node:http` server (no framework). One
 * `StreamableHTTPServerTransport` per MCP session is maintained in a session map; a fresh MCP
 * server instance is connected per session, sharing the underlying SDK client and preview store.
 *
 * Security (enforced here, covered by tests):
 *  - refuses to bind a non-loopback host unless a bearer token is configured;
 *  - requires `Authorization: Bearer <token>` (timing-safe) on /mcp when a token is configured;
 *  - validates the Host header (loopback + configured allowlist);
 *  - validates the browser Origin header against the configured allowlist (absence is allowed);
 *  - caps request bodies at 4 MB;
 *  - only emits CORS headers for allowlisted origins (never as an auth substitute).
 * `GET /healthz` is exempt from auth and echoes no configuration.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  extractBearerToken,
  isHostAllowed,
  isLoopbackHostname,
  isOriginAllowed,
  timingSafeEqualStrings,
} from "../auth/index.js";
import type { McpHttpConfig } from "../config/index.js";
import type { Logger } from "../tools/index.js";
import type { NeweggMcpServer } from "./build.js";

const BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export interface StartHttpServerOptions {
  readonly http: McpHttpConfig;
  /** Builds a fresh MCP server instance for a new session (sharing client/preview store). */
  readonly createServer: () => NeweggMcpServer;
  readonly logger: Logger;
  readonly serverInfo: { readonly name: string; readonly version: string };
}

export interface HttpServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
}

type BodyOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "too_large" | "bad_json" };

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function jsonRpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function readBody(req: IncomingMessage): Promise<BodyOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (outcome: BodyOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        finish({ ok: false, reason: "too_large" });
        // Drain (do not destroy) the rest so the 413 response can still be delivered.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        finish({ ok: true, value: undefined });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, reason: "bad_json" });
      }
    });
    req.on("error", () => finish({ ok: false, reason: "bad_json" }));
  });
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<HttpServerHandle> {
  const { http: httpConfig, createServer, logger, serverInfo } = options;

  if (!isLoopbackHostname(httpConfig.host) && httpConfig.bearerToken === undefined) {
    throw new Error(
      "Refusing to bind the MCP HTTP transport to a non-loopback host without " +
        "NEWEGG_MCP_HTTP_BEARER_TOKEN configured.",
    );
  }

  const sessions = new Map<string, SessionEntry>();

  async function createSession(): Promise<SessionEntry> {
    const created = createServer();
    let closed = false;
    const closeSession = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await created.close();
      } catch (error) {
        logger("error", "http_session_close_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) {
        sessions.delete(sessionId);
      }
      void closeSession();
    };
    await created.server.connect(transport);
    return { transport, close: closeSession };
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = firstHeader(req, "mcp-session-id");

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body.ok) {
        if (body.reason === "too_large") {
          sendJson(res, 413, jsonRpcError(null, -32600, "Request body exceeds the 4 MB limit."));
        } else {
          sendJson(
            res,
            400,
            jsonRpcError(null, -32700, "Parse error: request body is not valid JSON."),
          );
        }
        return;
      }

      let entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
      let createdHere = false;
      if (entry === undefined) {
        if (sessionId !== undefined) {
          sendJson(res, 404, jsonRpcError(null, -32001, "Session not found."));
          return;
        }
        if (!isInitializeRequest(body.value)) {
          sendJson(
            res,
            400,
            jsonRpcError(null, -32600, "No valid session ID for a non-initialize request."),
          );
          return;
        }
        entry = await createSession();
        createdHere = true;
      }

      await entry.transport.handleRequest(req, res, body.value);

      if (createdHere) {
        const newSessionId = entry.transport.sessionId;
        if (newSessionId !== undefined) {
          sessions.set(newSessionId, entry);
        } else {
          await entry.close();
        }
      }
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (sessionId === undefined) {
        sendJson(res, 400, jsonRpcError(null, -32600, "Missing Mcp-Session-Id header."));
        return;
      }
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        sendJson(res, 404, jsonRpcError(null, -32001, "Session not found."));
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, jsonRpcError(null, -32600, "Method not allowed."));
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = firstHeader(req, "host") ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const pathname = url.pathname;
    const origin = firstHeader(req, "origin");

    if (req.method === "OPTIONS") {
      if (origin !== undefined && isOriginAllowed(origin, httpConfig.allowedOrigins)) {
        setCorsHeaders(res, origin);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(origin !== undefined ? 403 : 204);
      res.end();
      return;
    }

    if (pathname === "/healthz" && req.method === "GET") {
      // Exempt from auth; no marketplace/seller/config echo.
      sendJson(res, 200, { status: "ok", server: serverInfo.name, version: serverInfo.version });
      return;
    }

    if (pathname !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (!isOriginAllowed(origin, httpConfig.allowedOrigins)) {
      sendJson(res, 403, jsonRpcError(null, -32600, "Origin not allowed."));
      return;
    }
    if (origin !== undefined) {
      setCorsHeaders(res, origin);
    }

    if (!isHostAllowed(firstHeader(req, "host"), httpConfig.allowedHosts)) {
      sendJson(res, 403, jsonRpcError(null, -32600, "Host not allowed."));
      return;
    }

    if (httpConfig.bearerToken !== undefined) {
      const token = extractBearerToken(firstHeader(req, "authorization"));
      if (token === undefined || !timingSafeEqualStrings(token, httpConfig.bearerToken)) {
        sendJson(res, 401, jsonRpcError(null, -32001, "Unauthorized."), {
          "www-authenticate": "Bearer",
        });
        return;
      }
    }

    await handleMcp(req, res);
  }

  const httpServer = createHttpServer((req, res) => {
    route(req, res).catch((error) => {
      logger("error", "http_request_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify(jsonRpcError(null, -32603, "Internal server error.")));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(httpConfig.port, httpConfig.host, () => {
      httpServer.off("error", onError);
      resolve();
    });
  });

  const address = httpServer.address();
  const port =
    address !== null && typeof address === "object"
      ? (address as AddressInfo).port
      : httpConfig.port;

  return {
    port,
    close: async () => {
      for (const entry of sessions.values()) {
        await entry.transport.close().catch(() => undefined);
        await entry.close();
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
