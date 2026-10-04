// v5 §1.4 e2e (ORDER; the lead runs Playwright), against the seeded sample data in the style of the v4 specs: setup
// that is not a screen (which table card to scan, a leftover open tab of the member) goes through Node/the API; every
// step the flow is about is done on screen.
//   bar staff create a category + an item with a photo on the Menu screen → the member opens the table QR link (logs
//   in on the way, returnTo) → orders from Bar & Café → the bar accepts it in Incoming orders → the kitchen prepares it
//   on the KDS ("via app") → the member gets "Your order is ready" → the bar settles the tab in cash → the bar drawer
//   goes up by the tab total.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
// MENU's signer: exactly what the printed table QR card encodes (`<APP_URL>/t/<token>`).
import { signTableToken } from "../../src/server/services/table-token";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PW = process.env.SEED_MEMBER_PASSWORD ?? "";
const MEMBER = { phone: "9811000002", name: "Neha Kapoor" }; // sample persona (Silver: 10% bar discount)
const RUN = Date.now() % 100000;
const CATEGORY = `E2E Order Snacks ${RUN}`;
const ITEM = `E2E Paneer tikka ${RUN}`;
const db = new PrismaClient();

type Session = { ctx: BrowserContext; page: Page };
let bar: Session;
let barOpenedDrawer = false;

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

/** The bar's drawer on screen (if it isn't open already): the Bar Till with a ₹500 float, so cash can be taken. */
async function openBarDrawerUi(s: Session) {
  await s.page.goto("/app/drawer");
  const opener = s.page.getByTestId("drawer-opener");
  const openCard = s.page.getByText(/drawer · open since/i);
  await expect(opener.or(openCard)).toBeVisible();
  if (await opener.isVisible()) {
    await opener.getByLabel("Till").selectOption({ label: "Bar Till" });
    await opener.getByLabel("₹500 notes", { exact: true }).fill("1");
    await opener.getByRole("button", { name: /Open drawer/ }).click();
    barOpenedDrawer = true;
  }
  await expect(s.page.getByText(/drawer · open since/i)).toBeVisible();
}

async function drawerCash(s: Session): Promise<number> {
  const d = await (await s.ctx.request.get("/api/drawer")).json();
  return d.data.open.cashExpected as number;
}

test.beforeAll(async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD").toBeGreaterThanOrEqual(8);
  expect(MEMBER_PW.length, "set SEED_MEMBER_PASSWORD").toBeGreaterThanOrEqual(8);
  bar = await loginUi(browser, "bar@championsclub.example", STAFF_PW, /\/app\/bar/);
  await openBarDrawerUi(bar);
});

test.afterAll(async () => {
  // Leave the sample menu as it was: the e2e item is archived (never deleted) and its category hidden.
  const item = await db.menuItem.findFirst({ where: { name: ITEM } });
  if (item) await bar.ctx.request.post(`/api/bar/menu/${item.id}/status`, { data: { status: "ARCHIVED" } });
  const cat = await db.barMenuCategory.findFirst({ where: { name: CATEGORY } });
  if (cat) await bar.ctx.request.patch(`/api/bar/menu/categories/${cat.id}`, { data: { active: false } });
  if (barOpenedDrawer) {
    const d = await (await bar.ctx.request.get("/api/drawer")).json();
    if (d.data?.open) await bar.ctx.request.post("/api/drawer/close", { data: { cashCounted: d.data.open.cashExpected, note: "v5 order e2e" } });
  }
  await bar.ctx.close();
  await db.$disconnect();
});

test("v5 §1.4: menu item with a photo → member scans the table QR and orders → bar accepts → KDS → ready → settled in cash → drawer up", async ({ browser }) => {
  // 1. Bar staff build a category and an item with a photo on the Menu screen (MENU's screen).
  const page = bar.page;
  await page.goto("/app/bar/menu");
  await page.getByTestId("new-category").click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Category name").fill(CATEGORY);
  await dialog.getByRole("button", { name: "Add category" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("menu-categories")).toContainText(CATEGORY);
  await page.getByTestId("new-menu-item").click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(ITEM);
  await dialog.getByLabel("Category", { exact: true }).selectOption({ label: CATEGORY });
  await dialog.getByLabel("Price (₹)").fill("120");
  await dialog.getByLabel("Food or drink").selectOption("FOOD");
  await dialog.getByLabel("Food type").selectOption("VEG");
  await dialog.getByLabel("Prep time (minutes, optional)").fill("10");
  await dialog.getByLabel("Photo", { exact: true }).setInputFiles({
    name: "paneer.png", mimeType: "image/png",
    buffer: await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 230, g: 150, b: 70 } } }).png().toBuffer(),
  });
  await dialog.getByRole("button", { name: "Create item" }).click();
  await expect(dialog).toBeHidden();

  // A leftover open tab of the sample member (seed history) is settled first, so the ₹3,000 limit can't get in the way.
  const member = await db.member.findUniqueOrThrow({ where: { phone: MEMBER.phone } });
  for (const t of await db.tab.findMany({ where: { memberId: member.id, status: "OPEN" } })) {
    const b = await db.bill.findUniqueOrThrow({ where: { id: t.billId } });
    const due = b.total - (b.amountPaid - b.amountRefunded);
    const res = due > 0
      ? await bar.ctx.request.post(`/api/bar/tabs/${t.id}/settle`, { data: { payments: [{ method: "CASH", amount: due }] } })
      : await bar.ctx.request.post(`/api/bar/tabs/${t.id}/close`, { data: {} });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  // 2. The member scans the table card: not logged in yet → log in (returnTo) → back on /t/ → Bar & Café at that table.
  const table = await db.barTable.findFirstOrThrow({ orderBy: { number: "asc" } });
  const mctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const m = await mctx.newPage();
  await m.goto(`/t/${signTableToken(table.id)}`);
  await m.waitForURL(/\/login\?returnTo=/);
  await m.getByLabel("Phone or email").fill(MEMBER.phone);
  await m.getByLabel("Password").fill(MEMBER_PW);
  await m.getByRole("button", { name: "Log in" }).click();
  await m.waitForURL(/\/portal\/bar/);
  await expect(m.getByTestId("ordering-status")).toContainText(`table ${table.number}`);
  // A tampered card shows the error page instead.
  await m.goto(`/t/${signTableToken(table.id).slice(0, -2)}xx`);
  await expect(m.getByTestId("table-scan-error")).toContainText("This table code is not valid");

  // 3. Order from Bar & Café: the photo, the Silver price (₹120 − 10%), a note; it waits for the bar.
  await m.goto("/portal/bar");
  await m.getByTestId("menu-search").fill(ITEM);
  const row = m.getByTestId("menu-view-item").filter({ hasText: ITEM });
  await expect(row.getByRole("img", { name: ITEM })).toBeVisible();
  await expect(row.getByTestId("menu-view-price")).toHaveText("₹108");
  await row.getByRole("button", { name: `Add ${ITEM}` }).click();
  await m.getByLabel(`Note for ${ITEM}`).fill("less spicy");
  await m.getByTestId("place-order").click();
  await expect(m.getByTestId("bar-notice")).toContainText("waiting for the bar to accept it");
  const myTab = m.getByTestId("my-open-tab");
  await expect(myTab.getByTestId("tab-line").filter({ hasText: ITEM })).toContainText("Waiting for the bar");
  await expect(m.getByTestId("settle-note")).toContainText("Settle at the bar before you leave");

  // 4. The bar accepts it in Incoming orders (at the scanned table).
  await page.goto("/app/bar");
  const incoming = page.getByTestId("incoming-order").filter({ hasText: ITEM });
  await expect(incoming).toBeVisible();
  await expect(incoming).toContainText(MEMBER.name);
  await expect(incoming).toContainText("less spicy");
  await expect(incoming.getByLabel(`Table for ${MEMBER.name}'s order`)).toHaveValue(table.id);
  await incoming.getByTestId("incoming-accept").click();
  await expect(incoming).toBeHidden();

  // 5. The kitchen sees it "via app" and makes it.
  const kitchen = await loginUi(browser, "kitchen@championsclub.example", STAFF_PW, /\/app\/bar\/kds/);
  const ticket = kitchen.page.getByTestId("kds-ticket").filter({ hasText: ITEM });
  await expect(ticket.getByTestId("kds-source")).toHaveText(/via app/i);
  await expect(ticket).toContainText("less spicy");
  await ticket.getByRole("button", { name: "Start" }).first().click();
  await ticket.getByRole("button", { name: "Ready" }).first().click();
  await kitchen.ctx.close();

  // 6. The member is told "Your order is ready" (bell + push) and sees READY on the tab.
  await m.goto("/portal/notifications");
  await expect(m.getByText("Your order is ready").first()).toBeVisible();
  const ready = await db.notificationDelivery.findMany({ where: { event: "BAR_ORDER_READY", memberId: member.id, channel: { in: ["IN_APP", "PUSH"] } }, orderBy: { createdAt: "desc" }, take: 2 });
  expect(ready.find((d) => d.channel === "IN_APP")?.status).toBe("SENT");
  await m.goto("/portal/bar");
  await expect(m.getByTestId("tab-line").filter({ hasText: ITEM })).toHaveAttribute("data-status", "READY");

  // 7. The bar settles the tab in cash ("via app" on the tab screen); the drawer goes up by the tab total.
  const item = await db.menuItem.findFirstOrThrow({ where: { name: ITEM } });
  const line = await db.tabLine.findFirstOrThrow({ where: { menuItemId: item.id }, orderBy: { createdAt: "desc" } });
  const tab = await db.tab.findUniqueOrThrow({ where: { id: line.tabId } });
  const bill = await db.bill.findUniqueOrThrow({ where: { id: tab.billId } });
  const due = bill.total - (bill.amountPaid - bill.amountRefunded);
  expect(due).toBe(10800);
  const before = await drawerCash(bar);
  await page.goto(`/app/bar/tabs/${tab.id}`);
  await expect(page.getByText("via app").first()).toBeVisible();
  await page.getByTestId("settle-open").click();
  const settle = page.getByRole("dialog");
  await page.getByTestId("settle-submit").click();
  await expect(settle.getByText(/Tab settled/)).toBeVisible();
  expect(await drawerCash(bar)).toBe(before + due);
  const receipt = await db.notificationDelivery.findFirst({ where: { event: "BAR_TAB_SETTLED", memberId: member.id, channel: "IN_APP", dedupeKey: { startsWith: `bar-tab-settled:${tab.id}` } } });
  expect(receipt?.status).toBe("SENT");
  await m.goto("/portal/bar");
  await expect(m.getByTestId("past-tabs")).toContainText(tab.code);
  await mctx.close();
});
