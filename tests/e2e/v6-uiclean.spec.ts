// v6 §5 e2e (UICLEAN; the lead runs Playwright) against the seeded sample data: page headers are compact and carry no
// description (UI-1, UI-3) on the staff app, and the ⓘ popover opens on click and closes with Escape, returning focus
// to its button (UI-2). The Sample data banner stays (UI-5).
import { expect, test, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";

async function loginUi(browser: Browser, identifier: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(STAFF_PW);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/app/);
  return page;
}

test("1. UI-1/UI-3: staff page headers are one compact line with no description", async ({ browser }) => {
  const owner = await loginUi(browser, "owner@championsclub.example");
  for (const [url, title] of [["/app/pricing", "Price book"], ["/app/refunds", "Refunds"], ["/app/finance/drawers", "Cash drawers"], ["/app/members", "Members"]] as const) {
    await owner.goto(url);
    const header = owner.locator("[data-page-header]").first();
    await expect(header.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(header.locator("p")).toHaveCount(0);
    const size = await header.getByRole("heading", { level: 1 }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(22);
    expect(size).toBeLessThanOrEqual(28);
  }
  await expect(owner.getByText("Sample data").first()).toBeVisible();
  await owner.context().close();
});

test("2. UI-2: the ⓘ on the price book opens on click and closes with Escape, focus back on the button", async ({ browser }) => {
  const owner = await loginUi(browser, "owner@championsclub.example");
  await owner.goto("/app/pricing");
  const info = owner.getByRole("button", { name: "Which rule wins" });
  await expect(info).toHaveAttribute("aria-expanded", "false");
  await info.click();
  await expect(info).toHaveAttribute("aria-expanded", "true");
  const note = owner.getByRole("note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("special date");
  await owner.keyboard.press("Escape");
  await expect(note).toBeHidden();
  await expect(info).toBeFocused();
  await owner.context().close();
});
