import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "mcp-server",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
