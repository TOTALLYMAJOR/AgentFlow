import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/test/**/*.test.ts", "apps/**/test/**/*.test.tsx"],
    exclude: ["**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
