// Unit tests for the live-suite read-only guard's client-surface scan (live-readonly/client-types.ts).
// Everything runs in temp fixture trees; the real repo is never touched.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientTypeProblems } from "../live-readonly/client-types.js";

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
});
