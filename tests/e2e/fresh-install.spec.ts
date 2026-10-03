// Completion pass §11: a brand-new club, from an empty database to the first member — through the real CLI and
// the real screens. Starts its own app on port 3300 against a separate `<db>_fresh` database (wiped first), so the
// running sample instance is never touched.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

test.describe.configure({ mode: "serial" });

const PORT = 3300;
const BASE = `http://localhost:${PORT}`;
const devUrl = new URL(process.env.DATABASE_URL ?? "postgresql://champions:champions@localhost:5442/champions");
const freshDb = `${devUrl.pathname.slice(1)}_fresh`;
const freshUrl = (() => {
  const u = new URL(devUrl.toString());
  u.pathname = `/${freshDb}`;
  return u.toString();
})();
const OWNER = { name: "Fresh Owner", phone: "9123400001", email: "owner@fresh.example", password: "fresh-owner-pass" };
const DESK = { name: "Fresh Desk", phone: "9123400002", password: "fresh-desk-pass" };
let server: ChildProcess | null = null;
let owner: { ctx: BrowserContext; page: Page };

async function login(browser: import("@playwright/test").Browser, id: string, pw: string, lands: RegExp) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(id);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands);
  return { ctx, page };
}

test.beforeAll(async () => {
  test.setTimeout(15 * 60_000);
  // 1. An empty database with every migration applied.
  const admin = new PrismaClient({ datasources: { db: { url: devUrl.toString() } } });
  const exists = await admin.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM pg_database WHERE datname = ${freshDb}`;
  if (!exists.length) await admin.$executeRawUnsafe(`CREATE DATABASE "${freshDb}"`);
  await admin.$disconnect();
  const fresh = new PrismaClient({ datasources: { db: { url: freshUrl } } });
  await fresh.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
  await fresh.$executeRawUnsafe("CREATE SCHEMA public");
  await fresh.$disconnect();
  const env = { ...process.env, DATABASE_URL: freshUrl, APP_URL: BASE, NODE_ENV: "production" as const };
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env, stdio: "pipe" });
  // 2. The built app on its own port, pointed at the empty database.
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { env, stdio: "ignore", detached: true });
  for (let i = 0; i < 180; i++) {
    const ok = await fetch(`${BASE}/login`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
});

test.afterAll(async () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await owner?.ctx.close();
});

test("1. an empty install promises nothing: cash only, no online payment, no identity, no sample banner", async ({ request }) => {
  const caps = await (await request.get(`${BASE}/api/capabilities`)).json();
  expect(caps.data).toMatchObject({ counterMethods: ["CASH"], online: false, email: false, delivery: null, gst: false, upiVpa: null, clubName: "", sampleData: false });
  expect((await request.get(`${BASE}/pay/test/anything`)).status()).toBe(404);
  const home = await (await request.get(`${BASE}/`)).text();
  expect(home).not.toContain("Sample data");
});

test("2. `npm run create-owner` makes the one Owner (a second is refused)", async () => {
  const env = { ...process.env, DATABASE_URL: freshUrl, APP_URL: BASE, OWNER_PASSWORD: OWNER.password };
  const out = execFileSync("npx", ["tsx", "scripts/create-owner.ts", "--name", OWNER.name, "--phone", OWNER.phone, "--email", OWNER.email], { env, encoding: "utf8" });
  expect(out).toContain(`Owner ${OWNER.name} created`);
  let second = "";
  try {
    execFileSync("npx", ["tsx", "scripts/create-owner.ts", "--name", "Second", "--phone", "9123400009"], { env, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    second = String((e as { stderr?: Buffer }).stderr ?? e);
  }
  expect(second).toContain("An Owner already exists");
});

test("3. the Owner lands in the setup wizard; the staff app stays closed until it is finished", async ({ browser }) => {
  owner = await login(browser, OWNER.email, OWNER.password, /\/setup/);
  const page = owner.page;
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
  await expect(page.getByTestId("setup-finish")).toBeDisabled();
  await page.goto("/app");
  await page.waitForURL(/\/setup/);
  await page.getByLabel("Club name *").fill("Fresh Test Club");
  await page.getByLabel("Address *").fill("12 New Road, Vadodara 390001");
  await page.getByLabel("State *").selectOption("24");
  await page.getByLabel("Phone").fill("0265 222 3333");
  await page.getByRole("button", { name: "Save club details" }).click();
  await expect(page.getByText("Not GST-registered: no GST is charged.")).toBeVisible();
  await page.getByLabel("Court name").fill("Court A");
  await page.getByRole("button", { name: "Add court" }).click();
  await expect(page.getByText(/Court A \(tennis\)/)).toBeVisible();
  await expect(page.getByTestId("setup-finish")).toBeEnabled();
  await page.getByTestId("setup-finish").click();
  await page.waitForURL(/\/app$/);
  await expect(page.getByRole("link", { name: /Fresh Test Club · Staff/ })).toBeVisible();
});

test("4. the Owner adds a front-desk user, who lands on Today and signs up the first member — cash only", async ({ browser }) => {
  const res = await owner.ctx.request.post("/api/users", { data: { name: DESK.name, phone: DESK.phone, role: "FRONT_DESK", password: DESK.password, monthlySalary: 2_000_000, joinDate: "2026-01-01" } });
  expect(res.status()).toBe(200);
  const desk = await login(browser, DESK.phone, DESK.password, /\/app\/desk/);
  const page = desk.page;
  await expect(page.getByTestId("desk-today")).toBeVisible();
  await page.goto("/app/members/new");
  await page.locator('input[name="name"]').fill("First Member");
  await page.locator('input[name="phone"]').fill("9123400100");
  await page.locator('input[name="dob"]').fill("1990-01-01");
  await page.getByRole("button", { name: /Silver/ }).click();
  expect((await page.locator('select[name="method"] option').allTextContents()).map((t) => t.trim())).toEqual(["Cash", "Not now — membership stays pending"]);
  await page.getByTestId("member-consent").check();
  await page.getByTestId("signup-submit").click();
  // A cash payment needs the desk's drawer: it is opened right there, then the sign-up goes through.
  const opener = page.getByTestId("drawer-opener");
  await expect(opener.or(page.getByText(/is registered as CC-\d{6}/))).toBeVisible();
  if (await opener.isVisible()) {
    // v4 §2.3 changed this line (was: an "Opening float" total): the float is counted by denomination (₹1,000).
    await opener.getByLabel("₹500 notes", { exact: true }).fill("2");
    await opener.getByRole("button", { name: "Open drawer" }).click();
    await page.getByTestId("signup-submit").click();
  }
  // Member codes come from a sequence: the refused first attempt may have used a number (gaps are normal).
  await expect(page.getByText(/is registered as CC-\d{6}/)).toBeVisible();
  await desk.ctx.close();
});

test("5. the public site carries the new club's name and is open to search engines", async ({ request }) => {
  const home = await (await request.get(`${BASE}/`)).text();
  expect(home).toContain("Fresh Test Club");
  const robots = await (await request.get(`${BASE}/robots.txt`)).text();
  expect(robots).toContain("Disallow: /app");
  expect(robots).not.toMatch(/Disallow: \/\s*$/m);
});
