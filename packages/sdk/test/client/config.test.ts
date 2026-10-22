import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/client/config.js";
import {
  NeweggConfigurationError,
  NeweggMarketplaceMismatchError,
} from "../../src/errors/index.js";
import { noopLogger } from "../../src/logging/index.js";
import { SDK_VERSION } from "../../src/version.js";
import type { NeweggClientConfig } from "../../src/types.js";

const stubFetch = (() => Promise.resolve(new Response("{}"))) as typeof globalThis.fetch;

function base(overrides: Partial<NeweggClientConfig> = {}): NeweggClientConfig {
  return {
    sellerId: "A006",
    apiKey: "key-abc",
    secretKey: "secret-xyz",
    marketplace: "us",
    fetch: stubFetch,
    ...overrides,
  };
}

function configError(config: unknown): NeweggConfigurationError {
  try {
    resolveConfig(config as NeweggClientConfig);
  } catch (err) {
    expect(err).toBeInstanceOf(NeweggConfigurationError);
    return err as NeweggConfigurationError;
  }
  throw new Error("expected resolveConfig to throw");
}

describe("resolveConfig defaults", () => {
  it("fills every default for a minimal config", () => {
    const resolved = resolveConfig(base());
    expect(resolved.baseUrl.toString()).toBe("https://api.newegg.com/marketplace/");
    expect(resolved.timeoutMs).toBe(30_000);
    expect(resolved.retry).toEqual({ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 10_000 });
    expect(resolved.logger).toBe(noopLogger);
    expect(resolved.fetch).toBe(stubFetch);
    expect(resolved.userAgent).toContain(`newegg-marketplace-sdk/${SDK_VERSION}`);
    expect(resolved.maxQuantity).toBeUndefined();
    expect(resolved.reportFileFtp).toBeUndefined();
    expect(resolved.rateLimitStore).toBeDefined();
    expect(resolved.operationStore).toBeDefined();
  });

  it("keeps caller-provided values", () => {
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const resolved = resolveConfig(
      base({
        marketplace: "ca",
        credentialMarketplace: "ca",
        timeoutMs: 1234,
        userAgent: "custom/1.0",
        logger,
        maxQuantity: 50,
        retry: { maxAttempts: 5 },
      }),
    );
    expect(resolved.marketplace).toBe("ca");
    expect(resolved.timeoutMs).toBe(1234);
    expect(resolved.userAgent).toBe("custom/1.0");
    expect(resolved.logger).toBe(logger);
    expect(resolved.maxQuantity).toBe(50);
    expect(resolved.retry).toEqual({ maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 10_000 });
  });
});

describe("resolveConfig credential and marketplace validation", () => {
  it.each(["sellerId", "apiKey", "secretKey"] as const)("rejects an empty %s", (field) => {
    expect(configError(base({ [field]: "   " })).message).toContain(`"${field}"`);
    expect(configError(base({ [field]: undefined as unknown as string })).message).toContain(
      `"${field}"`,
    );
  });

  it("rejects a non-object config", () => {
    expect(configError(null).message).toContain("Configuration object is required");
  });

  it("rejects an unknown marketplace", () => {
    expect(configError(base({ marketplace: "eu" as never })).message).toContain('"marketplace"');
  });

  it("rejects an unknown credentialMarketplace", () => {
    expect(configError(base({ credentialMarketplace: "eu" as never })).message).toContain(
      '"credentialMarketplace"',
    );
  });

  it("refuses credentials issued for another marketplace without echoing secrets", () => {
    const err = configError(base({ marketplace: "ca", credentialMarketplace: "us" }));
    expect(err).toBeInstanceOf(NeweggMarketplaceMismatchError);
    const mismatch = err as NeweggMarketplaceMismatchError;
    expect(mismatch.expectedMarketplace).toBe("ca");
    expect(mismatch.actualMarketplace).toBe("us");
    const serialized = JSON.stringify(err.toJSON());
    expect(serialized).not.toContain("key-abc");
    expect(serialized).not.toContain("secret-xyz");
  });
});

describe("resolveConfig baseUrl", () => {
  it("requires a trailing slash", () => {
    expect(configError(base({ baseUrl: "https://example.test/marketplace" })).message).toContain(
      'must end with "/"',
    );
  });

  it("requires an absolute URL", () => {
    expect(configError(base({ baseUrl: "not a url/" })).message).toContain("valid absolute URL");
  });

  it("refuses plain http for a non-loopback host", () => {
    expect(configError(base({ baseUrl: "http://example.test/" })).message).toContain("https");
  });

  it.each(["http://127.0.0.1:8080/", "http://localhost:3000/", "http://[::1]:3000/"])(
    "allows http on loopback (%s)",
    (baseUrl) => {
      expect(resolveConfig(base({ baseUrl })).baseUrl.protocol).toBe("http:");
    },
  );

  it("accepts a custom https base URL only with allowCustomBaseUrl", () => {
    expect(
      resolveConfig(base({ baseUrl: "https://example.test/api/", allowCustomBaseUrl: true }))
        .baseUrl.pathname,
    ).toBe("/api/");
  });
});

describe("resolveConfig baseUrl allowlist (T-6217)", () => {
  it.each([
    "https://api.newegg.com/marketplace/",
    "https://api.newegg.com/ec-mkp/",
    "https://newegg.com/marketplace/",
    "https://sandbox.api.newegg.com/marketplace/",
  ])("accepts the Newegg host by default (%s)", (baseUrl) => {
    expect(resolveConfig(base({ baseUrl })).baseUrl.toString()).toBe(baseUrl);
  });

  it.each([
    "https://evil.example/",
    "https://attacker.example/marketplace/",
    "https://evilnewegg.com/marketplace/",
    "https://newegg.com.evil.example/marketplace/",
    "https://newegg.com@evil.example/marketplace/",
    "https://api.newegg.com:pw@evil.example/marketplace/",
    "https://evil.example/api.newegg.com/",
    "https://evil.example/?h=api.newegg.com/",
  ])("refuses a non-Newegg host by default (%s)", (baseUrl) => {
    const error = configError(base({ baseUrl }));
    expect(error.message).toContain("allowCustomBaseUrl");
    const serialized = JSON.stringify(error) + error.message;
    expect(serialized).not.toContain("key-abc");
    expect(serialized).not.toContain("secret-xyz");
    expect(serialized).not.toContain("A006");
  });

  it("still allows a custom https host with allowCustomBaseUrl: true", () => {
    const resolved = resolveConfig(
      base({ baseUrl: "https://evil.example/marketplace/", allowCustomBaseUrl: true }),
    );
    expect(resolved.baseUrl.hostname).toBe("evil.example");
  });

  it("warns once, naming only the host, when a custom base URL is accepted", () => {
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
      warn: (event: string, fields?: Record<string, unknown>) => {
        warnings.push({ event, fields });
      },
    };
    resolveConfig(
      base({
        baseUrl: "https://user:pw@proxy.example/secret-path/",
        allowCustomBaseUrl: true,
        logger,
      }),
    );
    expect(warnings).toHaveLength(1);
    const serialized = JSON.stringify(warnings[0]);
    expect(serialized).toContain("proxy.example");
    for (const leaked of ["secret-path", "pw@", "user"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("does not warn for the default host or for loopback", () => {
    const warn: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
      warn: (event: string) => warn.push(event),
    };
    resolveConfig(base({ logger }));
    resolveConfig(base({ baseUrl: "http://127.0.0.1:8080/", logger }));
    expect(warn).toEqual([]);
  });

  it("allows loopback without the flag", () => {
    expect(resolveConfig(base({ baseUrl: "http://[::1]:3000/" })).baseUrl.protocol).toBe("http:");
  });

  it("refuses non-loopback http even with allowCustomBaseUrl", () => {
    expect(
      configError(base({ baseUrl: "http://example.test/", allowCustomBaseUrl: true })).message,
    ).toContain("https");
  });
});

describe("resolveConfig numeric fields", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number])(
    "rejects timeoutMs=%s",
    (timeoutMs) => {
      expect(configError(base({ timeoutMs })).message).toContain('"timeoutMs"');
    },
  );

  it.each([0, 1.5, -2])("rejects retry.maxAttempts=%s", (maxAttempts) => {
    expect(configError(base({ retry: { maxAttempts } })).message).toContain("retry.maxAttempts");
  });

  it("rejects negative retry delays", () => {
    expect(configError(base({ retry: { baseDelayMs: -1 } })).message).toContain(
      "retry.baseDelayMs",
    );
    expect(configError(base({ retry: { maxDelayMs: -1 } })).message).toContain("retry.maxDelayMs");
  });

  it("accepts zero retry delays", () => {
    expect(resolveConfig(base({ retry: { baseDelayMs: 0, maxDelayMs: 0 } })).retry).toMatchObject({
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
  });

  it.each([0, -3, 2.5])("rejects maxQuantity=%s", (maxQuantity) => {
    expect(configError(base({ maxQuantity })).message).toContain('"maxQuantity"');
  });

  it("rejects an invalid strategy.autoFeedThreshold", () => {
    expect(configError(base({ strategy: { autoFeedThreshold: 0 } })).message).toContain(
      "strategy.autoFeedThreshold",
    );
  });

  it("accepts a valid strategy.autoFeedThreshold", () => {
    expect(resolveConfig(base({ strategy: { autoFeedThreshold: 7 } })).autoFeedThreshold).toBe(7);
  });
});

describe("resolveConfig fetch", () => {
  it("rejects a non-function fetch", () => {
    expect(configError(base({ fetch: "nope" as never })).message).toContain("fetch");
  });
});

describe("resolveConfig reportFileFtp", () => {
  const FINGERPRINT = "ab".repeat(32);

  it("copies the options so later mutation does not leak in", () => {
    const options = { ftps: true, allowedPorts: [21] };
    const resolved = resolveConfig(base({ reportFileFtp: options }));
    expect(resolved.reportFileFtp).toEqual(options);
    expect(resolved.reportFileFtp).not.toBe(options);
  });

  it("rejects a non-object value", () => {
    expect(configError(base({ reportFileFtp: "x" as never })).message).toContain("reportFileFtp");
  });

  it("rejects a non-boolean ftps", () => {
    expect(configError(base({ reportFileFtp: { ftps: "yes" as never } })).message).toContain(
      "reportFileFtp.ftps",
    );
  });

  it("rejects a malformed pinned fingerprint", () => {
    expect(
      configError(base({ reportFileFtp: { ftps: true, tlsPinnedCertSha256: "abc", tlsCa: "pem" } }))
        .message,
    ).toContain("SHA-256 hex fingerprint");
  });

  it("refuses TLS options without ftps: true", () => {
    expect(
      configError(base({ reportFileFtp: { tlsPinnedCertSha256: FINGERPRINT, tlsCa: "pem" } }))
        .message,
    ).toContain("ftps: true");
    expect(configError(base({ reportFileFtp: { tlsCa: "pem" } })).message).toContain("ftps: true");
  });

  it("requires tlsCa alongside a pinned fingerprint", () => {
    expect(
      configError(base({ reportFileFtp: { ftps: true, tlsPinnedCertSha256: FINGERPRINT } }))
        .message,
    ).toContain("tlsCa");
  });

  it("accepts a colon-separated fingerprint with a CA", () => {
    const colon = FINGERPRINT.match(/../g)?.join(":");
    expect(
      resolveConfig(
        base({ reportFileFtp: { ftps: true, tlsPinnedCertSha256: colon, tlsCa: "pem" } }),
      ).reportFileFtp?.ftps,
    ).toBe(true);
  });

  it.each([[[]], [[0]], [[70000]], [[21.5]]])("rejects allowedPorts=%j", (allowedPorts) => {
    expect(configError(base({ reportFileFtp: { allowedPorts } })).message).toContain(
      "allowedPorts",
    );
  });
});
