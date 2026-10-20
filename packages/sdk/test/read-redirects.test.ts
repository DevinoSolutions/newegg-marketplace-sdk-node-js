import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNeweggClient, NeweggApiError } from "../src/index.js";
import {
  MAX_READ_REDIRECTS,
  REDIRECT_REFUSED_CROSS_ORIGIN,
  REDIRECT_REFUSED_DOWNGRADE,
  REDIRECT_REFUSED_INVALID_LOCATION,
  REDIRECT_REFUSED_TOO_MANY,
  redirectedMethod,
  resolveRedirectTarget,
} from "../src/client/redirect.js";
import { TEST_API_KEY, TEST_SECRET_KEY, US_SINGLE_ITEM } from "./helpers.js";
import { ORDER_NUMBER, orderResponse } from "./service-write-helpers.js";

/**
 * A read follows a redirect only to the SAME origin (never https -> http, at most 5 hops). Otherwise
 * `SecretKey` would be forwarded to a foreign host: fetch strips only Authorization, Cookie and
 * Proxy-Authorization on a cross-origin hop. Nothing here touches Newegg; the end-to-end cases talk
 * to servers on 127.0.0.1.
 */

interface Hit {
  method: string;
  path: string;
  secretKey: string | undefined;
  contentType: string | undefined;
  body: string;
}

const READ = { identifier: { type: "sellerPartNumber", value: "A006BSP3" } } as const;

describe("redirect target rules", () => {
  const original = new URL(
    "https://api.example.test/marketplace/ordermgmt/orderinfo?sellerid=A006",
  );

  it("resolves relative and root-relative Locations against the current URL", () => {
    const current = new URL("https://api.example.test/marketplace/a/b/c");
    expect(String(resolveRedirectTarget(original, current, "d?x=1"))).toBe(
      "https://api.example.test/marketplace/a/b/d?x=1",
    );
    expect(String(resolveRedirectTarget(original, current, "../up"))).toBe(
      "https://api.example.test/marketplace/a/up",
    );
    expect(String(resolveRedirectTarget(original, current, "/root"))).toBe(
      "https://api.example.test/root",
    );
    expect(String(resolveRedirectTarget(original, current, "https://api.example.test/abs"))).toBe(
      "https://api.example.test/abs",
    );
  });

  it("refuses another host, port or scheme-relative host", () => {
    for (const location of [
      "https://elsewhere.example/steal",
      "https://api.example.test:8443/steal",
      "//elsewhere.example/steal",
      "https://api.example.test.evil.example/steal",
    ]) {
      expect(resolveRedirectTarget(original, original, location), location).toBe(
        REDIRECT_REFUSED_CROSS_ORIGIN,
      );
    }
  });

  it("refuses an https -> http downgrade, even to the same host", () => {
    expect(resolveRedirectTarget(original, original, "http://api.example.test/marketplace/x")).toBe(
      REDIRECT_REFUSED_DOWNGRADE,
    );
  });

  it("refuses an unusable Location or one carrying credentials", () => {
    expect(resolveRedirectTarget(original, original, "http://[bad")).toBe(
      REDIRECT_REFUSED_INVALID_LOCATION,
    );
    expect(resolveRedirectTarget(original, original, "https://u:p@api.example.test/x")).toBe(
      REDIRECT_REFUSED_INVALID_LOCATION,
    );
  });

  it("rewrites the method like fetch: 303 -> GET, 301/302 only POST -> GET, 307/308 keep", () => {
    expect(redirectedMethod(303, "PUT")).toEqual({ method: "GET", dropBody: true });
    expect(redirectedMethod(303, "HEAD")).toEqual({ method: "HEAD", dropBody: false });
    expect(redirectedMethod(301, "POST")).toEqual({ method: "GET", dropBody: true });
    expect(redirectedMethod(302, "POST")).toEqual({ method: "GET", dropBody: true });
    for (const status of [301, 302, 307, 308]) {
      expect(redirectedMethod(status, "PUT"), String(status)).toEqual({
        method: "PUT",
        dropBody: false,
      });
    }
    expect(redirectedMethod(307, "POST")).toEqual({ method: "POST", dropBody: false });
  });
});

describe("read redirects against real loopback servers (global fetch)", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    const closing = servers.splice(0);
    await Promise.all(closing.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  /** Starts a loopback server; every request it receives is recorded in `hits`. */
  async function serve(handle: (req: IncomingMessage, res: ServerResponse, hits: Hit[]) => void) {
    const hits: Hit[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        hits.push({
          method: req.method ?? "",
          path: (req.url ?? "").split("?")[0] ?? "",
          secretKey: req.headers.secretkey as string | undefined,
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        handle(req, res, hits);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { port, hits };
  }

  function clientFor(port: number) {
    return createNeweggClient({
      sellerId: "A006",
      apiKey: TEST_API_KEY,
      secretKey: TEST_SECRET_KEY,
      marketplace: "us",
      baseUrl: `http://127.0.0.1:${port}/marketplace/`,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });
  }

  const json = (res: ServerResponse, body: unknown): void => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const redirect = (res: ServerResponse, status: number, location: string): void => {
    res.statusCode = status;
    res.setHeader("Location", location);
    res.end();
  };

  it("follows a same-origin redirect with an absolute Location and keeps the credentials", async () => {
    const { port, hits } = await serve((req, res) => {
      if (req.url?.startsWith("/marketplace/moved")) return json(res, US_SINGLE_ITEM);
      redirect(res, 301, `http://127.0.0.1:${port}/marketplace/moved/inventory`);
    });
    const snapshot = await clientFor(port).inventory.getItem(READ);
    expect(snapshot.itemNumber).toBe("9SIA0060884598");
    expect(hits).toHaveLength(2);
    expect(hits[1]?.path).toBe("/marketplace/moved/inventory");
    expect(hits[1]?.secretKey).toBe(TEST_SECRET_KEY);
  });

  it("resolves a relative Location", async () => {
    const { port, hits } = await serve((req, res) => {
      if (req.url?.startsWith("/marketplace/relative-target")) return json(res, US_SINGLE_ITEM);
      redirect(res, 302, "../../../relative-target");
    });
    await clientFor(port).inventory.getItem(READ);
    expect(hits).toHaveLength(2);
    expect(hits[1]?.path).toBe("/marketplace/relative-target");
  });

  it("keeps the PUT method and body of a read-on-PUT across a same-origin 302 (order-info)", async () => {
    const { port, hits } = await serve((req, res) => {
      if (req.url?.startsWith("/marketplace/moved")) return json(res, orderResponse({}));
      redirect(res, 302, "/marketplace/moved/orderinfo");
    });
    await clientFor(port).orders.get(ORDER_NUMBER);
    expect(hits).toHaveLength(2);
    expect(hits[1]?.method).toBe("PUT");
    expect(hits[1]?.path).toBe("/marketplace/moved/orderinfo");
    expect(hits[1]?.body).not.toBe("");
    expect(hits[1]?.body).toBe(hits[0]?.body);
    expect(hits[1]?.secretKey).toBe(TEST_SECRET_KEY);
  });

  it("turns a 303 into a body-less GET, per fetch", async () => {
    const { port, hits } = await serve((req, res) => {
      if (req.url?.startsWith("/marketplace/see-other")) return json(res, US_SINGLE_ITEM);
      redirect(res, 303, "/marketplace/see-other");
    });
    await clientFor(port).inventory.getItem(READ);
    expect(hits[1]?.method).toBe("GET");
    expect(hits[1]?.body).toBe("");
    expect(hits[1]?.contentType).toBeUndefined();
  });

  it("refuses a cross-origin redirect: SecretKey never reaches the second server, nothing is retried", async () => {
    const foreign = await serve((_req, res) => json(res, US_SINGLE_ITEM));
    const home = await serve((_req, res) =>
      redirect(res, 307, `http://127.0.0.1:${foreign.port}/marketplace/steal`),
    );
    const err = await clientFor(home.port)
      .inventory.getItem(READ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    const api = err as NeweggApiError;
    expect(api.retryable).toBe(false);
    expect(api.details).toMatchObject({ causeCode: REDIRECT_REFUSED_CROSS_ORIGIN });
    expect(JSON.stringify(api)).not.toContain(TEST_SECRET_KEY);
    expect(foreign.hits).toHaveLength(0);
    expect(home.hits).toHaveLength(1);
  });

  it("refuses a redirect to the same host on another port, a scheme-relative one and another hostname", async () => {
    const foreign = await serve((_req, res) => json(res, US_SINGLE_ITEM));
    for (const location of [
      `http://127.0.0.1:${foreign.port}/x`,
      `//127.0.0.1:${foreign.port}/x`,
      `http://localhost:${foreign.port}/x`,
    ]) {
      const home = await serve((_req, res) => redirect(res, 302, location));
      const err = await clientFor(home.port)
        .inventory.getItem(READ)
        .catch((e: unknown) => e);
      expect((err as NeweggApiError).details, location).toMatchObject({
        causeCode: REDIRECT_REFUSED_CROSS_ORIGIN,
      });
    }
    expect(foreign.hits).toHaveLength(0);
  });

  it(`follows ${MAX_READ_REDIRECTS} hops`, async () => {
    const { port, hits } = await serve((req, res) => {
      const step = Number(/\/hop\/(\d+)/.exec(req.url ?? "")?.[1] ?? "0");
      if (step >= MAX_READ_REDIRECTS) return json(res, US_SINGLE_ITEM);
      redirect(res, 302, `/marketplace/hop/${step + 1}`);
    });
    const snapshot = await clientFor(port).inventory.getItem(READ);
    expect(snapshot.itemNumber).toBe("9SIA0060884598");
    expect(hits).toHaveLength(MAX_READ_REDIRECTS + 1);
  });

  it("refuses a longer chain, and a redirect loop, with a single non-retried attempt", async () => {
    const { port, hits } = await serve((_req, res) => redirect(res, 302, "/marketplace/loop"));
    const err = await clientFor(port)
      .inventory.getItem(READ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect((err as NeweggApiError).details).toMatchObject({ causeCode: REDIRECT_REFUSED_TOO_MANY });
    expect((err as NeweggApiError).retryable).toBe(false);
    expect(hits).toHaveLength(MAX_READ_REDIRECTS + 1);
  });

  it("leaves write behaviour unchanged: a same-origin redirect on a write is not followed", async () => {
    const { port, hits } = await serve((_req, res) =>
      redirect(res, 302, `http://127.0.0.1:${port}/marketplace/moved`),
    );
    const result = await clientFor(port).inventory.updateItem({
      identifier: { type: "sellerPartNumber", value: "sku" },
      quantity: 5,
      warehouseLocation: "USA",
    });
    expect(result.items[0]?.status).toBe("failed");
    expect(result.items[0]?.message).toMatch(/redirect/i);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.method).toBe("POST");
  });
});

describe("read redirects with a stubbed fetch", () => {
  function httpsClient(fetchImpl: typeof globalThis.fetch) {
    return createNeweggClient({
      sellerId: "A006",
      apiKey: TEST_API_KEY,
      secretKey: TEST_SECRET_KEY,
      marketplace: "us",
      baseUrl: "https://api.example.test/marketplace/",
      fetch: fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });
  }

  it("refuses an https -> http downgrade, even to the same host, and does not contact it", async () => {
    const urls: string[] = [];
    const client = httpsClient((target) => {
      urls.push(String(target));
      return Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { Location: "http://api.example.test/marketplace/moved" },
        }),
      );
    });
    const err = await client.inventory.getItem(READ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeweggApiError);
    expect((err as NeweggApiError).details).toMatchObject({
      causeCode: REDIRECT_REFUSED_DOWNGRADE,
    });
    expect((err as NeweggApiError).retryable).toBe(false);
    expect(urls).toHaveLength(1);
  });

  it("follows a same-origin https redirect and sends every hop in manual mode", async () => {
    const seen: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
    const client = httpsClient((target, init) => {
      seen.push({ url: String(target), redirect: init?.redirect });
      if (seen.length === 1) {
        return Promise.resolve(
          new Response(null, { status: 308, headers: { Location: "/marketplace/moved" } }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(US_SINGLE_ITEM), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    const snapshot = await client.inventory.getItem(READ);
    expect(snapshot.itemNumber).toBe("9SIA0060884598");
    expect(seen.map((s) => s.redirect)).toEqual(["manual", "manual"]);
    expect(seen[1]?.url).toBe("https://api.example.test/marketplace/moved");
  });

  it("refuses a redirect whose Location cannot be parsed", async () => {
    const client = httpsClient(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { Location: "http://[bad" } })),
    );
    const err = await client.inventory.getItem(READ).catch((e: unknown) => e);
    expect((err as NeweggApiError).details).toMatchObject({
      causeCode: REDIRECT_REFUSED_INVALID_LOCATION,
    });
  });
});
