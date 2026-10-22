import { describe, expect, it, vi } from "vitest";
import type { HttpResult, NeweggHttpClient, RequestContext } from "../../src/client/http.js";
import { TransportError } from "../../src/client/transport.js";
import {
  IndeterminateOrderWriteError,
  NeweggApiError,
  NeweggRateLimitError,
} from "../../src/errors/index.js";
import type { RequestSpec } from "../../src/platform/index.js";
import { isMarkedNotBought } from "../../src/shippinglabel/ledger.js";
import { indeterminateLabelWrite, sendLabelWrite } from "../../src/shippinglabel/send.js";

const SPEC: RequestSpec = {
  method: "POST",
  path: "shippingservice/shippinglabel/create",
  body: {},
};
const META = { operation: "shippingLabels.create", orderNumber: "900000001" };
const OK: HttpResult = { status: 200, json: {}, bodyText: "{}", correlationId: "c1" };

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return { operation: "shippingLabels.create", correlationId: "c1", ...overrides };
}

function fakeHttp(
  steps: Array<HttpResult | Error>,
  options: { acquire?: () => Promise<void>; maxAttempts?: number } = {},
): { http: NeweggHttpClient; executeOnce: ReturnType<typeof vi.fn> } {
  let i = 0;
  const executeOnce = vi.fn(async () => {
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  });
  const http = {
    config: {
      marketplace: "us",
      retry: { maxAttempts: options.maxAttempts ?? 3, baseDelayMs: 0, maxDelayMs: 0 },
    },
    acquireRateLimit: options.acquire ?? (async () => undefined),
    executeOnce,
  } as unknown as NeweggHttpClient;
  return { http, executeOnce };
}

const preSend = (): TransportError =>
  new TransportError("pre-send", false, new Error("refused"), "ECONNREFUSED");
const ambiguous = (): TransportError =>
  new TransportError("ambiguous", false, new Error("reset"), "ECONNRESET");
const upstream = (status: number): NeweggApiError =>
  new NeweggApiError("upstream", { httpStatus: status, retryable: false });

async function run(http: NeweggHttpClient, c: RequestContext = ctx()): Promise<unknown> {
  return sendLabelWrite(http, SPEC, c, META).catch((e: unknown) => e);
}

describe("sendLabelWrite", () => {
  it("returns the result and the submission time on success", async () => {
    const { http, executeOnce } = fakeHttp([OK]);
    const out = (await sendLabelWrite(http, SPEC, ctx(), META)) as {
      result: HttpResult;
      submittedAtIso: string;
    };
    expect(out.result).toBe(OK);
    expect(new Date(out.submittedAtIso).toISOString()).toBe(out.submittedAtIso);
    expect(executeOnce).toHaveBeenCalledTimes(1);
  });

  it("marks a failed rate-limit acquisition as not bought and sends nothing", async () => {
    const failure = new NeweggRateLimitError("budget", {});
    const { http, executeOnce } = fakeHttp([OK], {
      acquire: async () => {
        throw failure;
      },
    });
    const error = await run(http);
    expect(error).toBe(failure);
    expect(isMarkedNotBought(error)).toBe(true);
    expect(executeOnce).not.toHaveBeenCalled();
  });

  it("retries a pre-send failure and then succeeds", async () => {
    const { http, executeOnce } = fakeHttp([preSend(), preSend(), OK]);
    const out = (await run(http)) as { result: HttpResult };
    expect(out.result).toBe(OK);
    expect(executeOnce).toHaveBeenCalledTimes(3);
  });

  it("gives up on repeated pre-send failures with a non-retryable error marked as not bought", async () => {
    const { http, executeOnce } = fakeHttp([preSend()], { maxAttempts: 2 });
    const error = await run(http);
    expect(executeOnce).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(error).not.toBeInstanceOf(IndeterminateOrderWriteError);
    expect((error as NeweggApiError).retryable).toBe(false);
    expect((error as NeweggApiError).correlationId).toBe("c1");
    expect(isMarkedNotBought(error)).toBe(true);
  });

  it("with maxAttempts 1 never retries even a pre-send failure", async () => {
    const { http, executeOnce } = fakeHttp([preSend(), OK], { maxAttempts: 1 });
    expect(await run(http)).toBeInstanceOf(NeweggApiError);
    expect(executeOnce).toHaveBeenCalledTimes(1);
  });

  it("treats an ambiguous transport failure as indeterminate, once, and not provably unsent", async () => {
    const { http, executeOnce } = fakeHttp([ambiguous(), OK]);
    const error = await run(http);
    expect(executeOnce).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(IndeterminateOrderWriteError);
    const indeterminate = error as IndeterminateOrderWriteError;
    expect(indeterminate.operation).toBe("shippingLabels.create");
    expect(indeterminate.orderNumber).toBe("900000001");
    expect(indeterminate.marketplace).toBe("us");
    expect(indeterminate.retryable).toBe(false);
    expect(indeterminate.cause).toBeInstanceOf(TransportError);
    expect(isMarkedNotBought(error)).toBe(false);
  });

  it.each([408, 500, 502, 503, 504, 599])(
    "treats an HTTP %i as indeterminate and never resends",
    async (status) => {
      const { http, executeOnce } = fakeHttp([upstream(status), OK]);
      expect(await run(http)).toBeInstanceOf(IndeterminateOrderWriteError);
      expect(executeOnce).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 401, 403, 404, 409, 422, 429])(
    "passes a definitive HTTP %i through unchanged",
    async (status) => {
      const failure = upstream(status);
      const { http, executeOnce } = fakeHttp([failure, OK]);
      expect(await run(http)).toBe(failure);
      expect(executeOnce).toHaveBeenCalledTimes(1);
    },
  );

  it("rethrows an error that carries no status and is not a transport failure", async () => {
    const failure = new Error("programming error");
    const { http } = fakeHttp([failure]);
    expect(await run(http)).toBe(failure);
  });

  it("marks a caller abort that happened before dispatch as not bought", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("aborted", "AbortError");
    const { http, executeOnce } = fakeHttp([abort]);
    const error = await run(http, ctx({ signal: controller.signal }));
    expect(error).toBe(abort);
    expect(isMarkedNotBought(error)).toBe(true);
    expect(executeOnce).toHaveBeenCalledTimes(1);
  });

  it("treats a caller abort after dispatch as indeterminate", async () => {
    const controller = new AbortController();
    const abort = new DOMException("aborted", "AbortError");
    const { http } = fakeHttp([abort]);
    const error = await run(http, ctx({ signal: controller.signal }));
    expect(error).toBeInstanceOf(IndeterminateOrderWriteError);
    expect((error as IndeterminateOrderWriteError).message).toContain("caller aborted");
    expect(isMarkedNotBought(error)).toBe(false);
  });
});

describe("indeterminateLabelWrite", () => {
  it("carries the label guidance, the submission time and the correlation id", () => {
    const { http } = fakeHttp([OK]);
    const cause = new Error("reset");
    const error = indeterminateLabelWrite(
      http,
      ctx(),
      META,
      "unknown outcome",
      "2026-10-20T00:00:00.000Z",
      cause,
    );
    expect(error).toBeInstanceOf(IndeterminateOrderWriteError);
    expect(error.message).toContain("unknown outcome");
    expect(error.submittedAtIso).toBe("2026-10-20T00:00:00.000Z");
    expect(error.correlationId).toBe("c1");
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error.toJSON())).toContain("reprint");
  });
});
