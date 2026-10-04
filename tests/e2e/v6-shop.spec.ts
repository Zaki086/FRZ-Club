// v6 §4 e2e (SHOP; the lead runs Playwright), against the seeded sample data in the style of the v4/v5 specs.
//   SM-1: the shop staff menu has "Café menu", which opens the menu builder.
//   TL-2 + WI-1/WI-5: shop staff open the Shop Till (the picker lists shop tills only), sell to a walk-in customer in
//   cash on Counter POS, and the receipt shows "Walk-in" (on screen and on the printed 80 mm receipt, with its QR).
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";

type Session = { ctx: BrowserContext; page: Page };
let shop: Session;
let shopOpenedDrawer = false;

async function loginUi(browser: Browser, identifier: string, password: string, lands?: RegExp): Promise<Session> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands ?? /\/(app|portal)/);
  return { ctx, page };
}

test.beforeAll(async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
  shop = await loginUi(browser, "shop@championsclub.example", STAFF_PW, /\/app\/shop/);
});

test.afterAll(async () => {
  if (shopOpenedDrawer) {
    const d = await (await shop.ctx.request.get("/api/drawer")).json();
    if (d.data?.open) await shop.ctx.request.post("/api/drawer/close", { data: { cashCounted: d.data.open.cashExpected, note: "v6 shop e2e" } });
  }
  await shop.ctx.close();
});

test("SM-1: shop staff see “Café menu” on their sidebar and it opens the menu builder", async () => {
  const page = shop.page;
  await page.goto("/app/shop");
  const link = page.getByRole("link", { name: "Café menu" });
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL(/\/app\/bar\/menu$/);
  await expect(page.getByRole("heading", { name: "Menu" })).toBeVisible();
});

test("TL-2 + WI-1/WI-5: shop staff open the Shop Till, sell to a walk-in customer in cash; the receipt says “Walk-in”", async () => {
  const page = shop.page;
  // Open the Shop Till by denomination (₹500 float) — the picker offers only shop tills.
  await page.goto("/app/drawer");
  const opener = page.getByTestId("drawer-opener");
  const openCard = page.getByText(/drawer · open since/i);
  await expect(opener.or(openCard)).toBeVisible();
  if (await opener.isVisible()) {
    const options = (await opener.getByLabel("Till").locator("option").allTextContents()).map((t) => t.replace(/ — open by .*/, "").trim());
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o).not.toMatch(/Front Desk|Bar Till|Office/);
    await opener.getByLabel("Till").selectOption({ label: "Shop Till" });
    await opener.getByLabel("₹500 notes", { exact: true }).fill("1");
    await opener.getByRole("button", { name: /Open drawer/ }).click();
    shopOpenedDrawer = true;
  }
  await expect(page.getByText(/drawer · open since/i)).toBeVisible();

  // Counter POS: an item, the walk-in switch (member search disappears), cash.
  await page.goto("/app/shop");
  await page.getByRole("button", { name: /avail\./ }).first().click();
  await expect(page.getByTestId("pos-submit")).toBeDisabled(); // no member and no walk-in yet
  await expect(page.getByTestId("pos-member-search")).toBeVisible();
  await page.getByTestId("walk-in-switch").check();
  await expect(page.getByTestId("pos-member-search")).toBeHidden();
  await page.getByLabel("Walk-in name").fill("E2E Walk-in");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByTestId("pos-submit").click();
  const receipt = page.getByTestId("sale-receipt");
  await expect(receipt).toBeVisible();
  await expect(receipt.getByTestId("sale-walk-in")).toHaveText("Walk-in");

  // The printed receipt: "WALK-IN" and the receipt QR (how the sale is found again for a refund).
  const [print] = await Promise.all([page.context().waitForEvent("page"), receipt.getByRole("link", { name: "Print receipt" }).click()]);
  await print.waitForLoadState();
  await expect(print.getByTestId("receipt-walk-in")).toHaveText("WALK-IN");
  await expect(print.getByTestId("receipt-qr").getByRole("img")).toBeVisible();
  await print.close();
});
