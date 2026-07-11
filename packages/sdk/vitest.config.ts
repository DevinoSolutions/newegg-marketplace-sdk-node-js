import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "sdk",
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**"],
  },
});
