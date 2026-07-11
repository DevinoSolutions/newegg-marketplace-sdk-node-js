import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "docs/api/**", "**/*.d.ts"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Library sources must not write to stdout (stdio MCP transport owns it).
    files: ["packages/*/src/**/*.ts"],
    rules: {
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["examples/**", "**/test/**", "scripts/**"],
    rules: {
      "no-console": "off",
    },
  },
  prettier,
);
