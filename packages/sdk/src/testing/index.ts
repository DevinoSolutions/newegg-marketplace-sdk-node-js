/**
 * Deterministic mock `fetch` for testing SDK integrations without network access. Matches
 * routes by method + path pattern, records each call (with parsed JSON body), and returns
 * `Response` objects built from the route's reply. Exported from
 * `@devino/newegg-marketplace-sdk/testing`.
 */

/** A single recorded request as observed by the mock. */
export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  bodyText?: string;
  bodyJson?: unknown;
}

/** The reply a route produces for a matched request. */
interface MockReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A route: matched by `method` plus `pathPattern` (string = substring of pathname, RegExp = tested against pathname+search). */
export interface MockRoute {
  method: string;
  pathPattern: RegExp | string;
  reply: (req: RecordedCall) => MockReply | Promise<MockReply>;
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

function toUrl(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.toString());
  return new URL(input.url);
}

function methodOf(input: FetchInput, init: FetchInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function headersOf(input: FetchInput, init: FetchInit): Headers {
  if (init?.headers) return new Headers(init.headers);
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

function matchPath(pattern: RegExp | string, url: URL): boolean {
  if (typeof pattern === "string") return url.pathname.includes(pattern);
  return pattern.test(`${url.pathname}${url.search}`);
}

function serializeBody(body: unknown): string {
  if (body === undefined) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

/**
 * Builds a mock `fetch` plus the array it records calls into. Unmatched requests get a
 * `501` JSON response so misconfigured tests fail loudly rather than hang.
 */
export function createMockFetch(routes: MockRoute[]): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    // Honor an already-aborted signal like a real fetch would (for cancellation tests).
    if (init?.signal?.aborted) {
      const reason = init.signal.reason;
      throw reason instanceof Error
        ? reason
        : new DOMException("The operation was aborted.", "AbortError");
    }
    const url = toUrl(input);
    const method = methodOf(input, init);
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    let bodyJson: unknown;
    if (bodyText !== undefined) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = undefined;
      }
    }
    const call: RecordedCall = { method, url, headers: headersOf(input, init), bodyText, bodyJson };
    calls.push(call);

    const route = routes.find(
      (candidate) =>
        candidate.method.toUpperCase() === method && matchPath(candidate.pathPattern, url),
    );
    if (!route) {
      return new Response(
        JSON.stringify({
          Code: "MOCK_NO_ROUTE",
          Message: `No mock route for ${method} ${url.pathname}`,
        }),
        { status: 501, headers: { "Content-Type": "application/json" } },
      );
    }

    const reply = await route.reply(call);
    return new Response(serializeBody(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  };

  return { fetch: mockFetch, calls };
}
