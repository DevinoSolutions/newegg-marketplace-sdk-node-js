import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/sdk/vitest.config.ts", "packages/mcp-server/vitest.config.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      reporter: ["text", "lcov"],
    },
  },
});
