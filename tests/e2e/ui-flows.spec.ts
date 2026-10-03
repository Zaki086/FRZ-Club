// Completion pass §9: click-through UI flows, every step in the browser, in two payment set-ups (Playwright projects
// "ui-cash" and "ui-card-upi"). Run against freshly seeded sample data (`npm run seed:demo` / `demo:reset`).
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PW = process.env.SEED_MEMBER_PASSWORD ?? "";
let utrSeq = Number(String(Date.now()).slice(-9));
const utr = () => `8${String(++utrSeq).padStart(11, "0")}`.slice(0, 12);

type Session = { ctx: BrowserContext; page: Page };
let mode: "cash" | "card_upi" = "cash";
let owner: Session;
let savedPaymentMethods: unknown = null;
const opened: Session[] = [];

async function loginUi(browser: Browser, identifier: string, password: string, lands?: RegExp): Promise<Session> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands ?? /\/(app|portal)/);
  return { ctx, page };
}

/** Open the drawer on screen (if it isn't already) — the way staff start a shift. */
async function openDrawerUi(s: Session, area: "Front desk" | "Shop" | "Bar") {
  await s.page.goto("/app/drawer");
  const opener = s.page.getByTestId("drawer-opener");
  const openCard = s.page.getByText(/drawer · open since/i);
  await expect(opener.or(openCard)).toBeVisible(); // the page loads its state first
  if (await opener.isVisible()) {
    await opener.getByLabel("Drawer").selectOption({ label: area });
    await opener.getByLabel("Opening float").fill("500");
    await opener.getByRole("button", { name: "Open drawer" }).click();
    opened.push(s);
  }
  await expect(s.page.getByText(/drawer · open since/i)).toBeVisible();
}

async function methodOptions(page: Page, select: ReturnType<Page["locator"]>) {
  return (await select.locator("option").allTextContents()).map((t) => t.trim());
}

test.beforeAll(async ({ browser }, info) => {
  mode = info.project.metadata?.payments === "card_upi" ? "card_upi" : "cash";
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD").toBeGreaterThanOrEqual(8);
  owner = await loginUi(browser, "owner@championsclub.example", STAFF_PW);
  const rows = await (await owner.ctx.request.get("/api/settings")).json();
  savedPaymentMethods = (rows.data as Array<{ key: string; value: unknown }>).find((r) => r.key === "payment_methods")?.value ?? null;
  const value = mode === "card_upi" ? { card_enabled: true, upi_vpa: "e2e.check@upi", upi_confirmed: true } : { card_enabled: false, upi_vpa: "", upi_confirmed: false };
  expect((await owner.ctx.request.put("/api/settings/payment_methods", { data: { value } })).status()).toBe(200);
});

test.afterAll(async () => {
  for (const s of opened) {
    const d = await (await s.ctx.request.get("/api/drawer")).json();
    if (d.data?.open) await s.ctx.request.post("/api/drawer/close", { data: { cashCounted: d.data.open.cashExpected, note: "ui e2e" } });
  }
  if (savedPaymentMethods) await owner.ctx.request.put("/api/settings/payment_methods", { data: { value: savedPaymentMethods } });
});

test("1. the Owner sees what the club can really do", async () => {
  await owner.page.goto("/app/settings");
  await owner.page.getByRole("tab", { name: "Payments & services" }).click();
  const status = owner.page.getByTestId("capability-status");
  await expect(status).toContainText("Online payment (Razorpay)");
  await expect(owner.page.getByTestId("cap-payments.online")).toContainText("Off");
  await expect(owner.page.getByTestId("cap-payments.card")).toContainText(mode === "card_upi" ? "On" : "Off");
  await expect(owner.page.getByTestId("cap-payments.upi")).toContainText(mode === "card_upi" ? "On" : "Off");
});

let desk: Session;
let bookedDay = 1;
const newPhone = `97${String(Date.now()).slice(-8)}`;

test("2. the front desk lands on Today, opens the drawer and signs up a member with only real payment methods", async ({ browser }) => {
  desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW, /\/app\/desk/);
  await expect(desk.page.getByTestId("desk-today")).toBeVisible();
  await openDrawerUi(desk, "Front desk");
  const page = desk.page;
  await page.goto("/app/members/new");
  await page.locator('input[name="name"]').fill(`Ui ${mode === "cash" ? "Cash" : "Card"} Member`);
  await page.locator('input[name="phone"]').fill(newPhone);
  await page.locator('input[name="dob"]').fill("1995-05-05");
  await page.locator('input[name="password"]').fill(MEMBER_PW);
  await page.getByRole("button", { name: /Silver/ }).click();
  const method = page.locator('select[name="method"]');
  const options = await methodOptions(page, method);
  if (mode === "cash") {
    expect(options).toContain("Cash");
    expect(options).not.toContain("UPI");
    expect(options).not.toContain("Card");
  } else {
    expect(options).toEqual(expect.arrayContaining(["Cash", "Card", "UPI"]));
    await method.selectOption("UPI");
    await page.getByLabel("UPI reference (UTR)").fill(utr());
    await expect(page.getByAltText("UPI QR code")).toBeVisible();
  }
  await page.getByTestId("member-consent").check();
  await page.getByTestId("signup-submit").click();
  await expect(page.getByText(/is registered as CC-\d{6}/)).toBeVisible();
  await expect(page.getByTestId("member-card")).toBeVisible();
});

test("3. a member books in the portal; online payment is not offered without a live gateway", async ({ browser }) => {
  const neha = await loginUi(browser, "9811000002", MEMBER_PW, /\/portal/);
  const page = neha.page;
  await page.goto("/portal/book");
  // From the day after tomorrow on (Silver books 5 days ahead), evening slots from the end of the day, until one is
  // free for Neha; each rejection is shown verbatim and we move on (a full day → the next day).
  const slots = page.locator('[data-testid^="slot-Court"]');
  const rejection = page.locator('[role="alert"].rounded-md');
  let booked = false;
  for (let day = mode === "cash" ? 2 : 3; day <= 5 && !booked; day++) {
    await page.getByRole("button", { name: /^(Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)/ }).nth(day).click();
    for (let k = 1; k <= 4 && !booked; k++) {
      const slot = slots.nth((await slots.count()) - k * 3);
      await slot.evaluate((el) => el.scrollIntoView({ block: "start" })); // clear of the sticky booking card
      await slot.click();
      await expect(page.getByTestId("portal-quote")).toBeVisible();
      await expect(page.getByText("Pay online now")).toHaveCount(0);
      await expect(page.getByText(/paid at the front desk before check-in/)).toBeVisible();
      await page.getByTestId("portal-confirm-booking").click();
      const ok = page.getByText(/BK-\d+ confirmed/);
      await expect(ok.or(rejection)).toBeVisible();
      booked = await ok.isVisible();
      if (booked) bookedDay = day;
      if (!booked && (await rejection.textContent())?.includes("DAILY_LIMIT_REACHED")) break;
    }
  }
  expect(booked).toBe(true);
  await neha.ctx.close();
});

test("4. the desk takes the booking fee in the payment panel", async () => {
  const page = desk.page;
  await page.goto("/app/courts/bookings");
  for (let i = 0; i < bookedDay; i++) await page.getByRole("button", { name: "Next day" }).click();
  await page.getByRole("row", { name: /Neha Kapoor/ }).first().click();
  const dialog = page.getByTestId("booking-detail");
  await expect(dialog).toBeVisible();
  const method = dialog.getByLabel("Method").first();
  const options = await methodOptions(page, method);
  if (mode === "cash") {
    expect(options).toEqual(["Cash"]);
  } else {
    await method.selectOption("CARD");
    await dialog.getByLabel("Card approval code").fill("UI4242");
    await dialog.getByLabel("Card last 4 digits").fill("4242");
  }
  await dialog.getByTestId("record-payment").click();
  // Paid in full: the panel closes and the booking shows nothing due.
  await expect(dialog).toContainText(/Due ₹0/);
  await expect(dialog).toContainText("PAID");
});

test("5. the shop sells at the till after opening its drawer", async ({ browser }) => {
  const shop = await loginUi(browser, "shop@championsclub.example", STAFF_PW, /\/app\/shop/);
  await openDrawerUi(shop, "Shop");
  const page = shop.page;
  await page.goto("/app/shop");
  await page.getByRole("button", { name: /avail\./ }).first().click();
  const methods = page.locator("div.col-span-3.flex.gap-1 button");
  const labels = (await methods.allTextContents()).map((t) => t.trim());
  if (mode === "cash") {
    expect(labels).toEqual(["Cash"]);
  } else {
    expect(labels).toEqual(["Cash", "Card", "UPI"]);
    await page.getByRole("button", { name: "UPI", exact: true }).click();
    await page.getByLabel("UPI reference (UTR)").fill(utr());
    await expect(page.getByAltText("UPI QR code")).toBeVisible();
  }
  await page.getByTestId("pos-submit").click();
  await expect(page.getByTestId("sale-receipt")).toBeVisible();
});

test("6. bar: open a guest tab, the kitchen prepares it (sound toggle on the KDS), then settle", async ({ browser }) => {
  const bar = await loginUi(browser, "bar@championsclub.example", STAFF_PW, /\/app\/bar/);
  await openDrawerUi(bar, "Bar");
  const page = bar.page;
  await page.goto("/app/bar");
  const guestName = `Ui Guest ${mode}`;
  await page.getByRole("button", { name: "Open tab" }).first().click();
  await page.getByRole("button", { name: "Guest", exact: true }).click();
  await page.getByLabel("Guest name *").fill(guestName);
  await page.getByRole("dialog").getByRole("button", { name: "Open tab" }).click();
  await page.waitForURL(/\/app\/bar\/tabs\//);
  await page.getByTestId("menu-item").filter({ hasText: /fries|sandwich|soda|tea|coffee/i }).first().click();
  await page.getByTestId("add-to-tab").click();
  await page.getByTestId("send-kitchen").click();
  const kitchen = await loginUi(browser, "kitchen@championsclub.example", STAFF_PW, /\/app\/bar\/kds/);
  await expect(kitchen.page.getByTestId("kds-sound")).toBeVisible();
  const ticket = kitchen.page.getByTestId("kds-ticket").filter({ hasText: guestName });
  await ticket.getByRole("button", { name: "Start" }).first().click();
  await ticket.getByRole("button", { name: "Ready" }).first().click();
  await kitchen.ctx.close();
  await page.reload();
  await page.getByTestId("settle-open").click();
  const settle = page.getByRole("dialog");
  if (mode === "card_upi") {
    await settle.getByLabel("Method").first().selectOption("UPI");
    await settle.getByLabel("UPI reference (UTR)").fill(utr());
  } else {
    expect(await methodOptions(page, settle.getByLabel("Method").first())).toEqual(["Cash"]);
  }
  await page.getByTestId("settle-submit").click();
  await expect(settle.getByText(/Tab settled/)).toBeVisible();
});

test("7. a visitor orders in the shop and pays at pickup (no online payment offered)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/shop");
  await page.getByRole("button", { name: /Add to cart/ }).first().click();
  await page.goto("/shop/cart");
  await expect(page.getByRole("button", { name: "Pay online now" })).toHaveCount(0);
  await expect(page.getByText(/Pay at the shop counter when you collect/)).toBeVisible();
  await page.getByLabel("Your name").fill("Ui Visitor");
  await page.getByLabel("Mobile").fill(`96${String(Date.now()).slice(-8)}`);
  await page.getByTestId("checkout-submit").click();
  await page.waitForURL(/\/orders\//);
  await expect(page.getByText("Collect at the club shop counter")).toBeVisible();
  await ctx.close();
});

test("8. the desk closes the drawer with a count; the accountant sees it in the day's reconciliation", async ({ browser }) => {
  const page = desk.page;
  const d = await (await desk.ctx.request.get("/api/drawer")).json();
  const expected = d.data.open.cashExpected as number;
  await page.goto("/app/drawer");
  await page.getByLabel("Counted cash").fill((expected / 100).toFixed(2));
  await page.getByRole("button", { name: "Close drawer" }).click();
  await expect(page.getByTestId("drawer-closed")).toContainText("no variance");
  opened.splice(opened.indexOf(desk), 1);
  const acc = await loginUi(browser, "accounts@championsclub.example", STAFF_PW, /\/app\/finance\/cash/);
  await expect(acc.page.getByRole("row", { name: /Farah Khan/ }).first()).toBeVisible();
  await acc.ctx.close();
});
