/**
 * Streamable HTTP transport on a plain `node:http` server (no framework). One
 * `StreamableHTTPServerTransport` per MCP session is maintained in a session map; a fresh MCP
 * server instance is connected per session, sharing the underlying SDK client and preview store.
 *
 * Security (enforced here, covered by tests):
 *  - refuses to bind a non-loopback host unless a bearer token is configured, and refuses a token
 *    shorter than 32 characters; warns when a non-loopback bind is not declared to sit behind a
 *    TLS proxy (this listener speaks plain HTTP);
 *  - refuses to start with write tools enabled and no bearer token, even on loopback: a loopback
 *    bind is reachable by every local user and process (T-6211);
 *  - requires `Authorization: Bearer <token>` (timing-safe) on /mcp when a token is configured;
 *    failed attempts are slowed per client address (exponential delay, then 429);
 *  - rejects a malformed Host header with 400 before anything else, and validates the Host header
 *    (loopback + configured allowlist);
 *  - validates the browser Origin header against the configured allowlist (absence is allowed);
 *  - caps request bodies at 4 MB and cuts the connection off instead of draining an oversize one;
 *  - bounds sessions: a maximum count and an idle timeout;
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
  isFetchSiteAllowed,
  isHostAllowed,
  isLoopbackHostname,
  isOriginAllowed,
  isWellFormedHostHeader,
  timingSafeEqualStrings,
} from "../auth/index.js";
import {
  DEFAULT_MAX_HTTP_SESSIONS,
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  weakBearerTokenReason,
  type McpHttpConfig,
} from "../config/index.js";
import type { Logger } from "../tools/index.js";
import type { NeweggMcpServer } from "./build.js";

const BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Grace between the 413 response and dropping the socket, so the client can read the answer. */
const OVERSIZE_CLOSE_GRACE_MS = 100;

/** Failed-bearer backoff: the k-th consecutive failure from one address waits base * 2^(k-1). */
const DEFAULT_AUTH_BACKOFF = { baseMs: 250, maxMs: 5000 };
/** Delayed failures one address may have in flight before further attempts get 429. */
const MAX_PENDING_FAILURES_PER_CLIENT = 8;
/** A client's failure count is forgotten after this long without a failure. */
const FAILURE_MEMORY_MS = 15 * 60_000;
/**
 * A good token lowers its address's failure count by one step, and at most once per this long. It
 * must not reset the count: behind a shared address (a proxy) a legitimate client would otherwise
 * erase an ongoing guessing run from another client with every request.
 */
const SUCCESS_DECAY_INTERVAL_MS = 1000;
const MAX_TRACKED_CLIENTS = 10_000;

export interface StartHttpServerOptions {
  readonly http: McpHttpConfig;
  /**
   * Whether the servers built by `createServer` register write tools (`NEWEGG_MCP_ALLOW_WRITES`).
   * Required, not optional, so a caller cannot forget it: when true, a bearer token is mandatory
   * even on loopback (T-6211).
   */
  readonly writesEnabled: boolean;
  /**
   * Builds a fresh MCP server instance for a new session (sharing client/preview store). The
   * session id is passed so the instance can bind its previews to that session.
   */
  readonly createServer: (sessionId: string) => NeweggMcpServer;
  readonly logger: Logger;
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** Failed-bearer backoff; defaults to 250 ms doubling up to 5 s. Mainly for tests. */
  readonly authBackoff?: { readonly baseMs: number; readonly maxMs: number };
}

export interface HttpServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
  /** Epoch ms of the last request (or its completion). */
  lastSeen: number;
  /** Requests currently being served (a long-lived GET stream counts as activity). */
  inflight: number;
}

interface ClientFailures {
  failures: number;
  lastAt: number;
  pending: number;
  /** When a good token last lowered `failures`. */
  lastDecayAt: number;
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
        // Stop reading: the kernel buffers fill and the client stalls. The caller answers 413 and
        // drops the socket; the rest of the body is never consumed.
        req.pause();
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

/**
 * Answers 413, then drops the socket shortly after instead of draining the upload. No
 * `Connection: close` header: that makes Node close at once, and closing a socket that still has
 * unread request bytes resets the connection, which can discard the 413 before the client reads it.
 */
function rejectOversize(req: IncomingMessage, res: ServerResponse): void {
  res.once("finish", () => {
    const socket = req.socket;
    setTimeout(() => socket.destroy(), OVERSIZE_CLOSE_GRACE_MS).unref();
  });
  sendJson(res, 413, jsonRpcError(null, -32600, "Request body exceeds the 4 MB limit."));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startHttpServer(options: StartHttpServerOptions): Promise<HttpServerHandle> {
  const { http: httpConfig, writesEnabled, createServer, logger, serverInfo } = options;
  const backoff = options.authBackoff ?? DEFAULT_AUTH_BACKOFF;
  const maxSessions = httpConfig.maxSessions ?? DEFAULT_MAX_HTTP_SESSIONS;
  const idleTtlMs = (httpConfig.sessionIdleTtlSeconds ?? DEFAULT_SESSION_IDLE_TTL_SECONDS) * 1000;

  if (!isLoopbackHostname(httpConfig.host) && httpConfig.bearerToken === undefined) {
    throw new Error(
      "Refusing to bind the MCP HTTP transport to a non-loopback host without " +
        "NEWEGG_MCP_HTTP_BEARER_TOKEN configured.",
    );
  }
  // `!== false`, not truthiness: a JS caller that omits the option (undefined) is treated as
  // writes-on, so the guard fails closed instead of open.
  if (writesEnabled !== false && httpConfig.bearerToken === undefined) {
    // Loopback is not a trust boundary: any local user or process could open its own session and
    // spend money (label purchases, price and listing writes). There is deliberately no opt-out.
    throw new Error(
      "Refusing to start the MCP HTTP transport with NEWEGG_MCP_ALLOW_WRITES=true and no " +
        "NEWEGG_MCP_HTTP_BEARER_TOKEN: write tools must not be reachable without authentication, " +
        "even on a loopback bind. Set NEWEGG_MCP_HTTP_BEARER_TOKEN (generate one with " +
        "`openssl rand -hex 32`), or disable writes (NEWEGG_MCP_ALLOW_WRITES=false).",
    );
  }
  const weakness =
    httpConfig.bearerToken === undefined
      ? undefined
      : weakBearerTokenReason(httpConfig.bearerToken);
  if (weakness !== undefined) {
    throw new Error(
      `Refusing to start the MCP HTTP transport: NEWEGG_MCP_HTTP_BEARER_TOKEN ${weakness}.`,
    );
  }

  const sessions = new Map<string, SessionEntry>();
  /** Sessions being created: counted against the cap before they reach the map. */
  let pendingSessions = 0;
  const clientFailures = new Map<string, ClientFailures>();

  async function createSession(sessionId: string): Promise<SessionEntry> {
    const created = createServer(sessionId);
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
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
    transport.onclose = () => {
      sessions.delete(sessionId);
      void closeSession();
    };
    await created.server.connect(transport);
    const entry: SessionEntry = {
      transport,
      close: closeSession,
      lastSeen: Date.now(),
      inflight: 0,
    };
    // Registered before the initialize response is written, so the client's very next request
    // (which already carries the session id) can never race the map.
    sessions.set(sessionId, entry);
    return entry;
  }

  /** Runs `work` for a session, keeping it marked active while requests are in flight. */
  async function serveSession(entry: SessionEntry, work: () => Promise<void>): Promise<void> {
    entry.inflight += 1;
    entry.lastSeen = Date.now();
    try {
      await work();
    } finally {
      entry.inflight -= 1;
      entry.lastSeen = Date.now();
    }
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = firstHeader(req, "mcp-session-id");

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body.ok) {
        if (body.reason === "too_large") {
          rejectOversize(req, res);
        } else {
          sendJson(
            res,
            400,
            jsonRpcError(null, -32700, "Parse error: request body is not valid JSON."),
          );
        }
        return;
      }

      const existing = sessionId !== undefined ? sessions.get(sessionId) : undefined;
      if (existing !== undefined) {
        await serveSession(existing, () => existing.transport.handleRequest(req, res, body.value));
        return;
      }
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
      if (sessions.size + pendingSessions >= maxSessions) {
        sendJson(res, 503, jsonRpcError(null, -32002, "Too many active sessions."), {
          "retry-after": "30",
        });
        return;
      }

      const newSessionId = randomUUID();
      pendingSessions += 1;
      let entry: SessionEntry;
      try {
        entry = await createSession(newSessionId);
      } finally {
        pendingSessions -= 1;
      }
      await serveSession(entry, () => entry.transport.handleRequest(req, res, body.value));
      if (entry.transport.sessionId === undefined) {
        // The transport refused the initialize: do not keep an unusable session around.
        sessions.delete(newSessionId);
        await entry.close();
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
      await serveSession(entry, () => entry.transport.handleRequest(req, res));
      return;
    }

    sendJson(res, 405, jsonRpcError(null, -32600, "Method not allowed."));
  }

  /**
   * Slows a failed bearer attempt: waits base * 2^(failures-1) (capped), and answers 429 once an
   * address already has too many delayed failures in flight, so parallel connections cannot
   * multiply the guess rate. Returns the response status to send.
   */
  async function throttleFailure(clientKey: string): Promise<401 | 429> {
    const now = Date.now();
    let state = clientFailures.get(clientKey);
    if (state === undefined || now - state.lastAt > FAILURE_MEMORY_MS) {
      state = { failures: 0, lastAt: now, pending: state?.pending ?? 0, lastDecayAt: 0 };
    }
    clientFailures.delete(clientKey);
    clientFailures.set(clientKey, state);
    if (clientFailures.size > MAX_TRACKED_CLIENTS) {
      const oldest = clientFailures.keys().next();
      if (oldest.done !== true) clientFailures.delete(oldest.value);
    }
    if (state.pending >= MAX_PENDING_FAILURES_PER_CLIENT) {
      return 429;
    }
    state.failures += 1;
    state.lastAt = now;
    state.pending += 1;
    const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (state.failures - 1));
    try {
      await sleep(delay);
    } finally {
      state.pending -= 1;
    }
    return 401;
  }

  /** A good token earns one step off its address's failure count, at most once per interval. */
  function decayFailures(clientKey: string): void {
    const state = clientFailures.get(clientKey);
    if (state === undefined || state.failures === 0) return;
    const now = Date.now();
    if (now - state.lastDecayAt < SUCCESS_DECAY_INTERVAL_MS) return;
    state.lastDecayAt = now;
    state.failures -= 1;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A malformed Host never reaches URL parsing, auth or the error log.
    const hostHeader = firstHeader(req, "host");
    if (hostHeader !== undefined && !isWellFormedHostHeader(hostHeader)) {
      sendJson(res, 400, jsonRpcError(null, -32600, "Malformed Host header."));
      return;
    }
    let pathname: string;
    try {
      // Only the request target is parsed; the base is a fixed placeholder, never the Host header.
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32600, "Malformed request target."));
      return;
    }
    const origin = firstHeader(req, "origin");
    const secFetchSite = firstHeader(req, "sec-fetch-site");

    if (req.method === "OPTIONS" || (pathname === "/healthz" && req.method === "GET")) {
      // Answered before the /mcp guards, so they get the Host and fetch-metadata checks here: a
      // DNS-rebinding page must not read the server name/version or probe preflights.
      if (!isHostAllowed(hostHeader, httpConfig.allowedHosts)) {
        sendJson(res, 403, jsonRpcError(null, -32600, "Host not allowed."));
        return;
      }
      if (!isFetchSiteAllowed(origin, secFetchSite)) {
        sendJson(res, 403, jsonRpcError(null, -32600, "Cross-site request not allowed."));
        return;
      }
    }

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
    if (!isFetchSiteAllowed(origin, secFetchSite)) {
      sendJson(res, 403, jsonRpcError(null, -32600, "Cross-site request not allowed."));
      return;
    }
    if (origin !== undefined) {
      setCorsHeaders(res, origin);
    }

    if (!isHostAllowed(hostHeader, httpConfig.allowedHosts)) {
      sendJson(res, 403, jsonRpcError(null, -32600, "Host not allowed."));
      return;
    }

    if (httpConfig.bearerToken !== undefined) {
      const clientKey = req.socket.remoteAddress ?? "unknown";
      const token = extractBearerToken(firstHeader(req, "authorization"));
      if (token === undefined || !timingSafeEqualStrings(token, httpConfig.bearerToken)) {
        const status = await throttleFailure(clientKey);
        if (status === 429) {
          sendJson(res, 429, jsonRpcError(null, -32003, "Too many failed attempts."), {
            "retry-after": String(Math.max(1, Math.ceil(backoff.maxMs / 1000))),
          });
        } else {
          sendJson(res, 401, jsonRpcError(null, -32001, "Unauthorized."), {
            "www-authenticate": "Bearer",
          });
        }
        return;
      }
      decayFailures(clientKey);
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

  if (!isLoopbackHostname(httpConfig.host) && httpConfig.behindTlsProxy !== true) {
    logger("warn", "http_plaintext_non_loopback", {
      host: httpConfig.host,
      message:
        "The MCP HTTP transport speaks plain HTTP: the bearer token and every tool result cross the " +
        "network in clear text. Put a TLS-terminating proxy in front and set " +
        "NEWEGG_MCP_HTTP_BEHIND_TLS_PROXY=true to acknowledge it.",
    });
  }

  // Idle sessions are closed so abandoned clients cannot hold memory forever.
  const sweepIntervalMs = Math.min(30_000, Math.max(50, Math.floor(idleTtlMs / 2)));
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (entry.inflight === 0 && now - entry.lastSeen > idleTtlMs) {
        sessions.delete(id);
        void entry.transport.close().catch(() => undefined);
        void entry.close();
      }
    }
  }, sweepIntervalMs);
  sweeper.unref();

  const address = httpServer.address();
  const port =
    address !== null && typeof address === "object"
      ? (address as AddressInfo).port
      : httpConfig.port;

  return {
    port,
    close: async () => {
      clearInterval(sweeper);
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
