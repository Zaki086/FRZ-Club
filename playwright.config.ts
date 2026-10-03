import { defineConfig, devices } from "@playwright/test";

const BASE = process.env.APP_URL ?? "http://localhost:3200";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE, trace: "retain-on-failure", navigationTimeout: 180_000, actionTimeout: 60_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Reuses a running `npm run dev` / `npm run start`; otherwise starts the production server.
  webServer: { command: "npm run start", url: `${BASE}/login`, reuseExistingServer: true, timeout: 15 * 60_000 },
});
