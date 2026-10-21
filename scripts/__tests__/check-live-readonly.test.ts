// Unit tests for the live-suite read-only guard's client-surface scan (live-readonly/client-types.ts).
// Everything runs in temp fixture trees; the real repo is never touched.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientTypeProblems, clientTypeScan } from "../live-readonly/client-types.js";

const CLIENT = "export interface NeweggClient { readonly marketplace: string; }\n";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-live-readonly-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes `files` (paths relative to packages/sdk/src) and returns the guard's problems. */
function problems(files: Record<string, string>): string[] {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, "packages", "sdk", "src", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return clientTypeProblems(root);
}

describe("clientTypeProblems", () => {
  it("raises no merge or stray-declaration problem for a client declared once in types/", () => {
    // The fixture lacks the real namespaces, so "allowlist lists X" problems are expected.
    const found = problems({ "types.ts": "export {};\n", "types/client.ts": CLIENT });
    expect(found.filter((p) => !p.includes(" lists "))).toEqual([]);
  });

  it("reads NeweggClient from a nested types/ directory", () => {
    const found = problems({
      "types.ts": "export {};\n",
      "types/nested/client.ts":
        "export interface NeweggClient { readonly marketplace: string; sneaky(): void; }\n",
    });
    expect(found.join("\n")).toContain("NeweggClient.sneaky is not classified");
  });

  it("fails when a nested types/ file merges a rogue method into NeweggClient", () => {
    const found = problems({
      "types.ts": "export {};\n",
      "types/client.ts": CLIENT,
      "types/nested/x.ts": "export interface NeweggClient { rogueWrite(): void; }\n",
    });
    expect(found.join("\n")).toContain("declaration merging");
  });

  it("fails when a file outside types/ declares or merges NeweggClient", () => {
    const found = problems({
      "types.ts": "export {};\n",
      "types/client.ts": CLIENT,
      "zz.ts": "interface NeweggClient { rogueWrite(): void; }\nexport {};\n",
    });
    expect(found.join("\n")).toContain("src/zz.ts declares NeweggClient");
  });

  it("fails on a NeweggClient merge inside a module augmentation", () => {
    const found = problems({
      "types.ts": "export {};\n",
      "types/client.ts": CLIENT,
      "deep/aug.ts":
        'declare module "../types.js" { interface NeweggClient { rogueWrite(): void } }\nexport {};\n',
    });
    expect(found.join("\n")).toContain("deep/aug.ts declares NeweggClient");
  });

  it("fails when a classified API interface is merged from another file", () => {
    const found = problems({
      "types.ts": "export {};\n",
      "types/client.ts":
        "export interface NeweggClient { readonly marketplace: string; readonly orders: OrdersApi; }\n" +
        "export interface OrdersApi { list(): void; }\n",
      "other/orders.ts": "export interface OrdersApi { ship(): void; }\n",
    });
    expect(found.join("\n")).toContain("other/orders.ts declares OrdersApi");
  });

  it("fails on an unclassified method on an existing API interface", () => {
    const found = problems({
      "types.ts": "export {};\n",
      "types/client.ts":
        "export interface NeweggClient { readonly marketplace: string; readonly orders: OrdersApi; }\n" +
        "export interface OrdersApi { list(): void; sneakyMutate(): void; }\n",
    });
    expect(found.join("\n")).toContain("client.orders.sneakyMutate");
  });

  it("ignores same-named classes in other files (they do not merge)", () => {
    const found = problems({
      "types.ts": "export {};\n",
      "types/client.ts":
        "export interface NeweggClient { readonly marketplace: string; readonly orders: OrdersApi; }\n" +
        "export interface OrdersApi { list(): void; }\n",
      "impl.ts": "export class OrdersApi { list(): void {} }\n",
    });
    expect(found.join("\n")).not.toContain("impl.ts");
  });

  const ORDERS = {
    "types.ts": "export {};\n",
    "types/client.ts":
      "export interface NeweggClient { readonly marketplace: string; readonly orders: OrdersApi; }\n",
    "types/orders.ts": "export interface OrdersApi { list(): void; }\n",
  };

  it("fails on module augmentation of an API interface inside a scanned types file", () => {
    const found = problems({
      ...ORDERS,
      "types/aug.ts":
        'declare module "./orders.js" { interface OrdersApi { x(): void } }\nexport {};\n',
    });
    expect(found.join("\n")).toContain("types/aug.ts declares OrdersApi");
  });

  it("fails on module augmentation of NeweggClient from a scanned file and from the barrel", () => {
    const inTypes = problems({
      ...ORDERS,
      "types/aug.ts":
        'declare module "./client.js" { interface NeweggClient { x(): void } }\nexport {};\n',
    });
    expect(inTypes.join("\n")).toContain("types/aug.ts declares NeweggClient");
    const inBarrel = problems({
      ...ORDERS,
      "types.ts":
        'declare module "./types/client.js" { interface NeweggClient { x(): void } }\nexport {};\n',
    });
    expect(inBarrel.join("\n")).toContain("src/types.ts declares NeweggClient");
  });

  it("fails on a class merged into the interface in the same module", () => {
    const found = problems({
      ...ORDERS,
      "types/orders.ts":
        "export interface OrdersApi { list(): void; }\nexport class OrdersApi { ship(): void {} }\n",
    });
    expect(found.join("\n")).toContain("types/orders.ts declares OrdersApi as a class");
  });

  it("fails on a class nested in a declare module block", () => {
    const found = problems({
      ...ORDERS,
      "impl/x.ts":
        'declare module "../types/orders.js" { class OrdersApi { ship(): void } }\nexport {};\n',
    });
    expect(found.join("\n")).toContain("impl/x.ts declares OrdersApi as a class");
  });

  it("fails on an interface that extends NeweggClient", () => {
    const found = problems({
      ...ORDERS,
      "ext.ts":
        'import type { NeweggClient } from "./types/client.js";\nexport interface ExtClient extends NeweggClient { rogue(): void }\n',
    });
    expect(found.join("\n")).toContain("extends NeweggClient");
  });

  it("fails on an interface extending a namespace-qualified NeweggClient", () => {
    const found = problems({
      ...ORDERS,
      "ext.ts":
        'import type * as T from "./types/client.js";\nexport interface X extends T.NeweggClient { rogue(): void }\n',
    });
    expect(found.join("\n")).toContain("ext.ts declares X, which extends NeweggClient");
  });

  it("fails on a class implementing NeweggClient, bare, qualified or aliased", () => {
    const bare = problems({
      ...ORDERS,
      "k1.ts":
        'import type { NeweggClient } from "./types/client.js";\nexport class K implements NeweggClient { marketplace = "us"; }\n',
    });
    expect(bare.join("\n")).toContain("k1.ts declares K, which extends NeweggClient");
    const qualified = problems({
      "k2.ts":
        'import type * as T from "./types/client.js";\nexport class K implements T.NeweggClient { marketplace = "us"; }\n',
    });
    expect(qualified.join("\n")).toContain("k2.ts declares K, which extends NeweggClient");
    const aliased = problems({
      "k3.ts":
        'import type { NeweggClient as C } from "./types/client.js";\nexport class K implements C { marketplace = "us"; }\n',
    });
    expect(aliased.join("\n")).toContain("k3.ts declares K, which extends NeweggClient");
  });

  it("does not flag an unrelated qualified heritage clause", () => {
    const found = problems({
      ...ORDERS,
      "ok.ts":
        'import type * as Foo from "./foo.js";\nexport interface Y extends Foo.Bar { z(): void }\nexport class Z implements Foo.Bar {}\n',
    });
    expect(found.join("\n")).not.toContain("ok.ts");
  });

  it("reports how many type files were read", () => {
    problems(ORDERS);
    expect(clientTypeScan(root).typeFiles).toBe(3);
  });
});
