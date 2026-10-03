import { defineConfig, devices } from "@playwright/test";

// `npm run audit:dummy` takes screenshots of the running app (APP_URL) with the sample logins.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: the variables must come from the environment
}
const BASE = process.env.APP_URL ?? "http://localhost:3200";

export default defineConfig({
  testDir: "tests/audit",
  testMatch: /screenshots\.spec\.ts/,
  timeout: 30 * 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE, navigationTimeout: 120_000, actionTimeout: 60_000 },
  projects: [{ name: "audit", use: { ...devices["Desktop Chrome"] } }],
});
