import { defineConfig, devices } from "@playwright/test";

// Sample logins (SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD) live in .env, never in the code.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: the variables must come from the environment
}

const BASE = process.env.APP_URL ?? "http://localhost:3200";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE, trace: "retain-on-failure", navigationTimeout: 180_000, actionTimeout: 60_000 },
  // The §12 demo first (it needs fresh sample data), then the click-through flows in two payment set-ups.
  projects: [
    { name: "demo", testMatch: /demo\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "ui-cash", testMatch: /ui-flows\.spec\.ts/, metadata: { payments: "cash" }, dependencies: ["demo"], use: { ...devices["Desktop Chrome"] } },
    { name: "ui-card-upi", testMatch: /ui-flows\.spec\.ts/, metadata: { payments: "card_upi" }, dependencies: ["ui-cash"], use: { ...devices["Desktop Chrome"] } },
    // v4 (role navigation, cash drawer v2, refunds v2, push, WhatsApp): after the click-through flows, cash only.
    { name: "v4", testMatch: /v4-[a-z]+\.spec\.ts/, dependencies: ["ui-card-upi"], use: { ...devices["Desktop Chrome"] } },
    // v5 (contact validation, bar menu builder, member ordering, message templates and composer), after v4, cash only.
    { name: "v5", testMatch: /v5-[a-z]+\.spec\.ts/, dependencies: ["v4"], use: { ...devices["Desktop Chrome"] } },
    // v6 (links, send all, leads drag & drop, shop walk-in and tills, clean UI), after v5, cash only.
    { name: "v6", testMatch: /v6-[a-z]+\.spec\.ts/, dependencies: ["v5"], use: { ...devices["Desktop Chrome"] } },
    // A brand-new club on its own port and database (never touches the sample instance).
    { name: "fresh-install", testMatch: /fresh-install\.spec\.ts/, timeout: 20 * 60_000, use: { ...devices["Desktop Chrome"] } },
  ],
  // Reuses a running `npm run dev` / `npm run start`; otherwise starts the production server.
  webServer: { command: "npm run start", url: `${BASE}/login`, reuseExistingServer: true, timeout: 15 * 60_000 },
});
