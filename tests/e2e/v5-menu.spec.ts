// v5 §1.1 e2e (the lead runs Playwright): bar staff build the menu on the Menu screen — a category, an item with a
// photo — then see it in "Preview as member", the A4 print and the table QR cards; the Manager opens the Menu screen
// by direct link. Run against the seeded sample data (the §1.4 member-ordering e2e is ORDER's v5-order spec).
import { expect, test, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const RUN = Date.now() % 100000;

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

test.beforeAll(() => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
});

test("MN: bar staff create a category and an item with a photo; preview, print and table QR cards show it", async ({ browser }) => {
  const page = await loginUi(browser, "bar@championsclub.example");
  await page.locator("aside nav").getByRole("link", { name: "Menu", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/bar\/menu$/);
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  const category = `E2E Snacks ${RUN}`;
  await page.getByTestId("new-category").click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Category name").fill(category);
  await dialog.getByLabel("Description").fill("Made fresh to order");
  await dialog.getByRole("radio", { name: "Sandwich" }).click();
  await dialog.getByRole("button", { name: "Add category" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("menu-categories")).toContainText(category);

  const item = `E2E Paneer roll ${RUN}`;
  await page.getByTestId("new-menu-item").click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(item);
  await dialog.getByLabel("Category", { exact: true }).selectOption({ label: category });
  await dialog.getByLabel("Price (₹)").fill("180");
  await dialog.getByLabel("Food or drink").selectOption("FOOD");
  await dialog.getByLabel("Food type").selectOption("VEG");
  await dialog.getByLabel("Gluten").check();
  await dialog.getByLabel("Prep time (minutes, optional)").fill("12");
  await dialog.getByLabel("Photo", { exact: true }).setInputFiles({
    name: "roll.png", mimeType: "image/png",
    buffer: await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 210, g: 140, b: 60 } } }).png().toBuffer(),
  });
  await dialog.getByRole("button", { name: "Create item" }).click();
  await expect(dialog).toBeHidden();

  await page.getByLabel("Search").fill(item);
  const row = page.getByTestId("menu-row").filter({ hasText: item });
  await expect(row).toBeVisible();
  await expect(row.getByRole("img", { name: "Veg" })).toBeVisible();

  // MN-1: bar staff change the base price from the item editor; the price history shows old → new.
  await row.click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Price (₹)").fill("190");
  await dialog.getByRole("button", { name: "Save item" }).click();
  await expect(dialog.getByTestId("menu-price-history")).toContainText("₹180");
  await expect(dialog.getByTestId("menu-price-history")).toContainText("₹190");
  await page.keyboard.press("Escape");

  // MN-4: exactly what members see — the item with its photo.
  await page.getByTestId("menu-preview-link").click();
  await expect(page).toHaveURL(/\/app\/bar\/menu\/preview/);
  const shown = page.getByTestId("menu-view-item").filter({ hasText: item });
  await expect(shown).toBeVisible();
  await expect(shown.getByRole("img", { name: item })).toBeVisible();
  await expect(shown).toContainText("Contains: Gluten");

  // MN-5 / MN-6: the A4 print and one QR card per table.
  await page.goto("/print/menu");
  await expect(page.getByText(item)).toBeVisible();
  await expect(page.getByText(category)).toBeVisible();
  await page.goto("/print/menu/tables");
  expect(await page.getByTestId("table-qr-card").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("table-qr-card").first().getByRole("img", { name: /QR code for table/ })).toBeVisible();
  await page.context().close();
});

test("MN: the Manager opens the Menu screen by direct link (it is not on the Manager's menu)", async ({ browser }) => {
  const page = await loginUi(browser, "manager@championsclub.example");
  await expect(page.locator("aside nav").getByRole("link", { name: "Menu", exact: true })).toHaveCount(0);
  await page.goto("/app/bar/menu");
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();
  await expect(page.getByTestId("new-menu-item")).toBeVisible();
  await page.context().close();
});
