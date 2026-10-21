import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sdkDistStaleness } from "./output-schema-drift-lib.js";

describe("sdkDistStaleness", () => {
  let root: string;
  const at = (file: string, seconds: number): void => {
    const when = new Date(seconds * 1000);
    fs.utimesSync(file, when, when);
  };
  const write = (relative: string, seconds: number): string => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "export {};\n");
    at(full, seconds);
    return full;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-staleness-"));
    write("src/index.ts", 1_000);
    write("src/types/orders.ts", 1_000);
    write("dist/index.d.ts", 2_000);
    write("dist/types/orders.d.ts", 2_000);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts a dist that is newer than its sources", () => {
    expect(sdkDistStaleness(root, false)).toBeUndefined();
  });

  it("ignores an orphan dist file whose source was deleted or renamed", () => {
    write("dist/zz-orphan.d.ts", 100);
    write("dist/types/old-name.d.ts", 100);
    expect(sdkDistStaleness(root, false)).toBeUndefined();
  });

  it("still fails when a dist file is older than its own source, including in subfolders", () => {
    write("src/types/orders.ts", 3_000);
    expect(sdkDistStaleness(root, false)).toContain("types/orders.d.ts");
  });

  it("fails when a source file has no dist counterpart", () => {
    write("src/newfile.ts", 1_000);
    expect(sdkDistStaleness(root, false)).toContain("newfile.d.ts");
  });

  it("fails when dist is missing, and does nothing on CI", () => {
    fs.rmSync(path.join(root, "dist"), { recursive: true });
    expect(sdkDistStaleness(root, false)).toContain("missing");
    expect(sdkDistStaleness(root, true)).toBeUndefined();
  });
});
