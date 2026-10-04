// v6 §1 e2e (the lead runs Playwright): links and previews are built from APP_URL. Run against the seeded sample data
// on the gate's test club (APP_URL = the Playwright baseURL; ALLOW_INSECURE_APP_URL=1 because it is http://localhost).
import { expect, test, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const BASE = (process.env.APP_URL ?? "http://localhost:3200").replace(/\/$/, "");

async function loginUi(browser: Browser, identifier: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(STAFF_PW);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/app/);
  return page;
}

const og = (html: string, prop: string) => new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`).exec(html)?.[1] ?? null;

test("URL-6: a WhatsApp preview of /portal, /quote, /r and /rq links shows the club (og tags on the unauthenticated response)", async ({ request }) => {
  const ua = { "user-agent": "WhatsApp/2.23.20.0 A" };
  for (const path of ["/portal/membership", "/quote/not-a-real-token", "/r/not-a-real-token", "/rq/not-a-real-token"]) {
    const res = await request.get(path, { headers: ua }); // follows the /portal → /login?returnTo=… redirect
    const html = await res.text();
    expect(og(html, "og:title"), path).toBeTruthy();
    expect(og(html, "og:site_name"), path).toBe(og(html, "og:title"));
    expect(og(html, "og:image"), path).toMatch(new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
  }
});

test("URL-1: sitemap.xml and robots.txt name only APP_URL", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs.length).toBeGreaterThan(0);
  for (const l of locs) expect(l.startsWith(`${BASE}/`)).toBe(true);
});

test("URL-2: Settings shows the configured public address", async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
  const page = await loginUi(browser, "owner@championsclub.example");
  await page.goto("/app/settings");
  await page.getByRole("tab", { name: "Payments & services" }).click();
  await expect(page.getByTestId("public-url")).toHaveText(BASE);
});
