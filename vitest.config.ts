import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/integration/**/*.test.ts", "tests/concurrency/**/*.test.ts", "tests/unit/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    setupFiles: ["tests/helpers/setup-env.ts"],
    // One real Postgres test database: files run one at a time, tests inside a file run in order.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 300_000,
    hookTimeout: 600_000,
  },
});
