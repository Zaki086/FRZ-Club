// v3 §10.3: screenshots of the main pages at 360 px and 1280 px for visual QA (before/after the design port).
// `SHOT_DIR=docs/screenshots/after npx playwright test -c playwright.screens.config.ts` against the running app.
import { mkdirSync } from "node:fs";
import { test } from "@playwright/test";

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PW = process.env.SEED_MEMBER_PASSWORD ?? "";
const DIR = process.env.SHOT_DIR ?? "docs/screenshots/after";
const SETS: Array<{ who: string; login?: string; pw?: string; pages: string[] }> = [
  { who: "public", pages: ["/", "/plans", "/availability", "/shop", "/trial", "/login"] },
  { who: "member", login: "9811000001", pw: MEMBER_PW, pages: ["/portal", "/portal/book", "/portal/membership", "/portal/account"] },
  { who: "owner", login: "owner@championsclub.example", pw: STAFF_PW, pages: ["/app", "/app/settings", "/app/reports", "/app/finance/gst"] },
  // v4 RN-1: the members list is not on the desk's menu any more; its dashboard and Check-in Risk are.
  { who: "desk", login: "desk@championsclub.example", pw: STAFF_PW, pages: ["/app", "/app/desk", "/app/desk/risk", "/app/courts", "/app/courts/bookings", "/app/crm"] },
  { who: "shop", login: "shop@championsclub.example", pw: STAFF_PW, pages: ["/app/shop", "/app/shop/stock"] },
  { who: "bar", login: "bar@championsclub.example", pw: STAFF_PW, pages: ["/app/bar"] },
  { who: "kitchen", login: "kitchen@championsclub.example", pw: STAFF_PW, pages: ["/app/bar/kds"] },
  { who: "accountant", login: "accounts@championsclub.example", pw: STAFF_PW, pages: ["/app/finance/cash", "/app/finance/expenses"] },
];

for (const set of SETS) {
  test(`screenshots: ${set.who}`, async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    mkdirSync(DIR, { recursive: true });
    for (const [label, width, height] of [["360", 360, 740], ["1280", 1280, 800]] as const) {
      const ctx = await browser.newContext({ viewport: { width, height } });
      const page = await ctx.newPage();
      if (set.login) {
        await page.goto("/login");
        await page.getByLabel("Phone or email").fill(set.login);
        await page.getByLabel("Password").fill(set.pw!);
        await page.getByRole("button", { name: "Log in" }).click();
        await page.waitForURL(/\/(app|portal)/);
      }
      for (const p of set.pages) {
        await page.goto(p, { waitUntil: "networkidle" });
        await page.waitForTimeout(400);
        const name = `${set.who}${p.replace(/\//g, "_") || "_home"}-${label}.png`;
        await page.screenshot({ path: `${DIR}/${name}`, fullPage: true });
      }
      await ctx.close();
    }
  });
}
