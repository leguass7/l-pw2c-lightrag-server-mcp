import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "src/cli.ts", "src/transport/stdio.ts"],
      reporter: ["text", "text-summary", "html"],
      reportsDirectory: "./coverage",
      thresholds: {
        lines: 90,
        branches: 89,
        functions: 90,
        statements: 90,
      },
    },
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
