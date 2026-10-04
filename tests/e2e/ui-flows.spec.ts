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

const TILL_OF = { "Front desk": "Front Desk Till 1", Shop: "Shop Till", Bar: "Bar Till" } as const;

/** Notes and coins (labels as on the count screens) that make `paise` — whole rupees. */
function countsFor(paise: number): Array<[string, string]> {
  const den: Array<[string, number]> = [["₹500 notes", 50000], ["₹200 notes", 20000], ["₹100 notes", 10000], ["₹50 notes", 5000], ["₹20 notes", 2000], ["₹10 notes", 1000], ["₹5 coins", 500], ["₹2 coins", 200], ["₹1 coins", 100]];
  let left = Math.floor(paise / 100) * 100;
  const out: Array<[string, string]> = [];
  for (const [label, v] of den) {
    const n = Math.floor(left / v);
    if (n) out.push([label, String(n)]);
    left -= n * v;
  }
  return out;
}

/** Open the drawer on screen (if it isn't already) — the way staff start a shift. */
async function openDrawerUi(s: Session, area: "Front desk" | "Shop" | "Bar") {
  await s.page.goto("/app/drawer");
  const opener = s.page.getByTestId("drawer-opener");
  const openCard = s.page.getByText(/drawer · open since/i);
  await expect(opener.or(openCard)).toBeVisible(); // the page loads its state first
  if (await opener.isVisible()) {
    // v4 §2.3 changed this helper (was: a drawer area and a float total): staff choose the till and count the float
    // by denomination (₹500 here, as before).
    await opener.getByLabel("Till").selectOption({ label: TILL_OF[area] });
    await opener.getByLabel("₹500 notes", { exact: true }).fill("1");
    await opener.getByRole("button", { name: /Open drawer/ }).click();
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
let nehaCode = "";
const newPhone = `97${String(Date.now()).slice(-8)}`;
let newMemberToken: string | null = null;

test("2. the front desk lands on Today, opens the drawer and signs up a member with only real payment methods", async ({ browser }) => {
  desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW, /\/app\/desk/);
  await expect(desk.page.getByTestId("desk-today")).toBeVisible();
  await openDrawerUi(desk, "Front desk");
  const page = desk.page;
  await page.goto("/app/members/new");
  await page.locator('input[name="name"]').fill(`Ui ${mode === "cash" ? "Cash" : "Card"} Member`);
  await page.locator('input[name="phone"]').fill(newPhone);
  await page.locator('input[name="dob"]').fill("1995-05-05");
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
  // v3 WK-1…WK-5: no password at the desk; paying created the login — the panel shows the QR and how it went out.
  const panel = page.getByTestId("credentials-panel");
  await expect(panel).toContainText(newPhone);
  await expect(panel.getByTestId("credentials-qr")).toBeVisible();
  await expect(panel.getByTestId("credentials-deliveries")).toContainText("In-app: Sent");
  await expect(panel.getByTestId("credentials-deliveries")).toContainText("WhatsApp (by hand): To send");
  const slip = await panel.getByRole("link", { name: "Print welcome slip" }).getAttribute("href");
  newMemberToken = new URL(slip!, "http://x").searchParams.get("t");
});

// v4 RN-1 changed this step (was: the front desk on the members list): the members list is on the Manager's menu, not
// the desk's (the desk searches members at Check-in & Search Members), so the Manager narrows it; the desk keeps the leads board.
test("2b. the manager narrows the members list from the summary strip and the search (state in the URL)", async ({ browser }) => {
  const mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
  const page = mgr.page;
  await page.goto("/app/members");
  await expect(page.getByTestId("summary-strip")).toBeVisible();
  await page.getByTestId("summary-strip").getByRole("button", { name: /With dues/ }).click();
  await page.waitForURL(/dues=yes/);
  await expect(page.getByRole("button", { name: /Remove filter Dues: Has dues/ })).toBeVisible();
  await page.getByLabel("Search").fill("Rahul");
  await page.waitForURL(/q=Rahul/);
  await expect(page.getByTestId("result-count")).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page).not.toHaveURL(/dues=yes/);
  await mgr.ctx.close();
  await desk.page.goto("/app/crm");
  await expect(desk.page.getByTestId("filter-bar")).toBeVisible();
  await expect(desk.page).toHaveURL(/status=NEW%2CCONTACTED%2CQUOTED|status=NEW,CONTACTED,QUOTED/);
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
      if (booked) {
        bookedDay = day;
        nehaCode = /BK-\d+/.exec((await ok.textContent()) ?? "")![0];
      }
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
  await page.getByRole("row").filter({ hasText: "Neha Kapoor" }).filter({ hasText: nehaCode }).click();
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
  // v6 WI-1 changed this (was: no customer chosen = a walk-in): a sale without a member is a walk-in by the switch.
  await page.getByTestId("walk-in-switch").check();
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
  // v4 CD-5/CD-7 changed this step (was: one "Counted cash" total): a blind count by denomination; the till's float
  // stays for the next shift and the rest goes to the safe in a sealed bag.
  await page.getByRole("button", { name: "Close drawer" }).click();
  const close = page.getByTestId("close-drawer");
  for (const [label, n] of countsFor(expected)) await close.getByLabel(label, { exact: true }).fill(n);
  await close.getByLabel("Sealed bag no.").fill("E2E-BAG-8");
  await close.getByRole("button", { name: "Count done — close drawer" }).click();
  await expect(page.getByTestId("drawer-closed")).toContainText("no variance");
  opened.splice(opened.indexOf(desk), 1);
  const acc = await loginUi(browser, "accounts@championsclub.example", STAFF_PW, /\/app\/finance\/cash/);
  await expect(acc.page.getByRole("row", { name: /Farah Khan/ }).first()).toBeVisible();
  await acc.ctx.close();
});

// v4 RN-1 changed this step (was: the front desk): the members list is on the Manager's menu, so the Manager follows the deep link.
test("9. a deep link survives login (returnTo); a session that ends mid-use asks to log in again in place", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/app/members?dues=yes");
  await page.waitForURL(/\/login\?returnTo=/);
  await page.getByLabel("Phone or email").fill("manager@championsclub.example");
  await page.getByLabel("Password").fill(STAFF_PW);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/app\/members\?dues=yes/);
  await expect(page.getByTestId("filter-bar")).toBeVisible();
  // The session ends on the server while the browser still has its cookie (idle timeout, or revoked elsewhere).
  const cookies = await ctx.cookies();
  expect((await ctx.request.post("/api/auth/logout")).ok()).toBe(true);
  await ctx.addCookies(cookies);
  // An action that only calls the API (saving a view) opens the dialog in place; what was typed stays.
  await page.getByRole("button", { name: "Saved views" }).click();
  await page.getByLabel("View name").fill("Members with dues");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const guard = page.getByTestId("session-guard");
  await expect(guard).toBeVisible();
  await expect(guard).toContainText("Your session ended — log in again to continue");
  await guard.getByLabel("Phone or email").fill("manager@championsclub.example");
  await guard.getByLabel("Password").fill(STAFF_PW);
  await guard.getByRole("button", { name: "Log in" }).click();
  await expect(guard).toBeHidden();
  await expect(page).toHaveURL(/\/app\/members\?dues=yes/);
  if (!(await page.getByLabel("View name").isVisible())) await page.getByRole("button", { name: "Saved views" }).click();
  await expect(page.getByLabel("View name")).toHaveValue("Members with dues");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Members with dues")).toBeVisible();
  // A page load after the session ended goes to the login page, says why, and comes back.
  const again = await ctx.cookies();
  await ctx.request.post("/api/auth/logout");
  await ctx.addCookies(again);
  await page.goto("/app/members?tier=GOLD");
  await page.waitForURL(/\/login\?returnTo=.*ended=1/);
  await expect(page.getByText("Your session ended — log in again to continue")).toBeVisible();
  await page.getByLabel("Phone or email").fill("manager@championsclub.example");
  await page.getByLabel("Password").fill(STAFF_PW);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/app\/members\?tier=GOLD/);
  // Tidy up the saved view.
  const views = await (await ctx.request.get("/api/views?list=members")).json();
  for (const v of views.data as Array<{ id: string; name: string }>) if (v.name === "Members with dues") await ctx.request.delete(`/api/views/${v.id}`);
  await ctx.close();
});

test("10. the manager sees who is in, opens an employee and corrects an attendance with a reason", async ({ browser }) => {
  const mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
  const page = mgr.page;
  await page.goto("/app/staff/employees");
  await expect(page.getByTestId("summary-strip")).toContainText("Clocked in now");
  await page.getByRole("link", { name: "Farah Khan" }).click();
  await expect(page.getByRole("heading", { name: "Farah Khan" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Attendance" })).toBeVisible();
  await expect(page.getByTestId("employee-summary")).toContainText("Leave left");
  await page.goto("/app/staff/attendance?range=LAST_7");
  await expect(page.getByTestId("filter-bar")).toBeVisible();
  const row = page.locator("tbody tr").filter({ has: page.getByRole("button", { name: /Correct|Fix clock-out/ }) }).first();
  await row.getByRole("button", { name: /Correct|Fix clock-out/ }).click();
  const dialog = page.getByRole("dialog");
  const clockIn = dialog.getByLabel("Clock-in");
  const v = await clockIn.inputValue(); // YYYY-MM-DDTHH:mm (IST)
  const m = Number(v.slice(-2));
  await clockIn.fill(`${v.slice(0, -2)}${String(m > 0 ? m - 1 : 1).padStart(2, "0")}`);
  await dialog.getByLabel("Reason (required)").fill("Checked against the front desk sign-in sheet");
  await dialog.getByRole("button", { name: "Save correction" }).click();
  await expect(dialog).toBeHidden();
  await page.goto("/app/staff/attendance?range=LAST_7&flag=edited");
  await expect(page.locator("tbody").getByText("Edited").first()).toBeVisible();
  await page.goto("/app/staff/attendance/summary");
  await expect(page.getByTestId("filter-bar")).toBeVisible();
  await mgr.ctx.close();
});

test("11. the desk asks for a refund on a paid booking; the manager approves; the desk pays it out in cash", async ({ browser }) => {
  const page = desk.page;
  await openDrawerUi(desk, "Front desk");
  await page.goto("/app/courts/bookings");
  for (let i = 0; i < bookedDay; i++) await page.getByRole("button", { name: "Next day" }).click();
  await page.getByRole("row").filter({ hasText: "Neha Kapoor" }).filter({ hasText: nehaCode }).click();
  const dialog = page.getByTestId("booking-detail");
  await dialog.getByRole("button", { name: "Request a refund" }).click();
  await dialog.getByLabel("Amount ₹").fill("100");
  await dialog.getByLabel("Reason").selectOption("SERVICE_ISSUE");
  await dialog.getByLabel("Note").fill("Floodlights failed for part of the session");
  await dialog.getByRole("button", { name: "Send for approval" }).click();
  const sent = dialog.getByTestId("refund-requested");
  await expect(sent).toContainText(/Refund RF-\d{6} for ₹100 sent for approval/);
  const code = /RF-\d{6}/.exec((await sent.textContent()) ?? "")![0];

  // v4 RN-4 changed this part (was: the manager approves on the refunds queue): the Manager approves inline in "Needs
  // your approval" on the dashboard; the row links to the refund's own page (as the approval notification does).
  const mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
  await mgr.page.goto("/app");
  const ask = mgr.page.getByTestId("approvals-panel").getByTestId("approval-row").filter({ hasText: code });
  await expect(ask).toContainText("₹100");
  await expect(ask.getByRole("link", { name: new RegExp(code) })).toHaveAttribute("href", /^\/app\/refunds\//);
  await ask.getByRole("button", { name: /^Approve/ }).click();
  await expect(mgr.page.getByTestId("approval-row").filter({ hasText: code })).toHaveCount(0);
  await mgr.ctx.close();

  // v4 RF-8/RF-9 changed this part (was: "Paid out" on the row): the approved refund is "Ready to collect"; the desk
  // compares the person with the member photo, ticks "Identity checked" (required), pays from the drawer and can print
  // the refund receipt; the row then reads "Collected".
  await page.goto(`/app/refunds?q=${code}`);
  const row = page.getByRole("row", { name: new RegExp(code) });
  await expect(row).toContainText("Ready to collect");
  await row.click();
  const payout = page.getByTestId("refund-payout");
  await expect(payout.getByTestId("payout-photo")).toBeVisible();
  const pay = payout.getByRole("button", { name: /^Pay out ₹100/ });
  await expect(pay).toBeDisabled();
  await payout.getByLabel("Identity checked").check();
  await payout.getByLabel("Method").selectOption("CASH");
  await pay.click();
  await expect(page.getByTestId("refund-paid-out")).toContainText(`${code} is collected`);
  await expect(page.getByTestId("refund-paid-out").getByRole("link", { name: "Print refund receipt" })).toHaveAttribute("href", /^\/print\/refund\//);
  await page.goto(`/app/refunds?q=${code}`);
  await expect(page.getByRole("row", { name: new RegExp(code) })).toContainText("Collected");
  await page.goto("/app/drawer");
  // v4 §2.4 changed this line (was: "Cash refunded"): the drawer's summary strip reads "Cash refunds" (count, ₹).
  await expect(page.getByTestId("cash-expected")).toContainText("Cash refunds");
});

test("12. the walk-in signed up in step 2 sets their own password from the link and logs in to the portal", async ({ browser }) => {
  expect(newMemberToken).toBeTruthy();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/set-password/${newMemberToken}`);
  await page.getByLabel("New password").fill("walkin-own-pass");
  await page.getByLabel("Repeat password").fill("walkin-own-pass");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("Password set.")).toBeVisible();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(newPhone);
  await page.getByLabel("Password").fill("walkin-own-pass");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/portal/);
  await page.goto("/portal/notifications");
  await expect(page.getByTestId("notification-settings")).toContainText("In the app");
  await ctx.close();
});

test("13. the manager closes a court with a reason; the member reschedules the cancelled booking at no extra charge", async ({ browser }) => {
  expect(nehaCode).toMatch(/^BK-/);
  const list = await (await desk.ctx.request.get(`/api/lists/bookings?q=${nehaCode}`)).json();
  const b = list.data.rows[0] as { court: string; start_at: string; end_at: string };
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
  const page = mgr.page;
  await page.goto("/app/courts");
  for (let i = 0; i < bookedDay; i++) await page.getByRole("button", { name: "Next day" }).click();
  await page.getByRole("button", { name: "Close courts" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(b.court, { exact: true }).check();
  await dialog.getByLabel("Closed from").selectOption(hhmm(b.start_at));
  await dialog.getByLabel("Closed until").selectOption(hhmm(b.end_at));
  await dialog.getByLabel("Closure reason").selectOption("WET_COURT");
  await dialog.getByLabel("Note for players").fill("Standing water after the rain");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByTestId("closure-preview")).toContainText(nehaCode);
  await dialog.getByRole("button", { name: "Close courts and notify" }).click();
  await expect(dialog.getByTestId("closure-done")).toContainText("waiting for the player's choice");
  await mgr.ctx.close();

  const neha = await loginUi(browser, "9811000002", MEMBER_PW, /\/portal/);
  await neha.page.goto("/portal/bookings");
  const choice = neha.page.getByTestId("needs-choice").getByTestId("club-cancellation-choice").first();
  await expect(choice).toContainText("Cancelled by the club");
  await choice.getByRole("button", { name: "Reschedule (free)" }).click();
  const day = choice.getByLabel("Day", { exact: true });
  await day.selectOption({ index: 3 });
  const slot = choice.getByLabel("Free slot", { exact: true });
  await expect(slot.locator("option")).not.toHaveCount(1);
  await slot.selectOption({ index: 1 });
  await choice.getByRole("button", { name: "Move here" }).click();
  await expect(neha.page.getByText("Moved to a new time at no extra charge").first()).toBeVisible();
  await neha.ctx.close();
});

// v4 RN-3 changed this step (was: the manager): the price book is the Owner's alone.
test("14. the owner creates a peak band in the price book; the price simulator and the public pages show it", async () => {
  const page = owner.page;
  // PR-15: the sample data has no pricing rules; end any left by the other payment set-up's run.
  const book = await (await owner.ctx.request.get("/api/pricing")).json();
  for (const r of book.data.rules as Array<{ id: string; state: string }>) if (r.state === "IN_EFFECT" || r.state === "SCHEDULED") await owner.ctx.request.post(`/api/pricing/rules/${r.id}/end`, { data: {} });
  await page.goto("/app/pricing");
  const form = page.getByTestId("rule-form");
  await form.getByLabel("Name").fill("Peak");
  await form.getByRole("button", { name: "Save rule" }).click();
  await expect(form.getByTestId("rule-saved")).toContainText("in effect now");
  await page.getByRole("tab", { name: "Price simulator" }).click();
  const sim = page.getByTestId("simulator");
  await sim.getByLabel("Tier").selectOption("WALK_IN");
  const d = new Date(Date.now() + 7 * 86_400_000); // a weekday a week ahead
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  await sim.getByLabel("Date").fill(d.toISOString().slice(0, 10));
  await sim.getByLabel("Time").fill("19:00");
  await sim.getByRole("button", { name: "Show the price" }).click();
  await expect(sim.getByTestId("simulator-result")).toContainText("Peak 18:00–21:00 +20%");
  await page.goto("/availability");
  await expect(page.getByTestId("price-notes")).toContainText("Peak +20%");
  // Leave the sample data's prices as they were for the next run.
  const after = await (await owner.ctx.request.get("/api/pricing")).json();
  for (const r of after.data.rules as Array<{ id: string; state: string }>) if (r.state === "IN_EFFECT") await owner.ctx.request.post(`/api/pricing/rules/${r.id}/end`, { data: {} });
});

test("15. the shop adds a product with photos; it appears in the public shop with its gallery", async ({ browser }) => {
  const { default: sharp } = await import("sharp");
  const png = (r: number) => sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r, g: 120, b: 80 } } }).png().toBuffer();
  const shop = await loginUi(browser, "shop@championsclub.example", STAFF_PW, /\/app\/shop/);
  const page = shop.page;
  const name = `E2E Grip ${mode} ${Date.now() % 100000}`;
  await page.goto("/app/shop/products");
  // v6 SM-2 changed this (was: "New product", then search the list and open the row): the primary "Add product"
  // button, and the new product's page opens by itself for its photos and discount.
  await page.getByRole("button", { name: "Add product" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Brand").fill("Club");
  await dialog.getByPlaceholder("SKU").fill(`E2E-${Date.now() % 1000000}`);
  await dialog.getByPlaceholder("Price ₹").fill("350");
  await dialog.getByRole("button", { name: "Create product" }).click();
  await expect(dialog).toBeHidden();
  await page.waitForURL(/\/app\/shop\/products\/[^/]+$/);
  await page.getByLabel("Add photos").setInputFiles([
    { name: "front.png", mimeType: "image/png", buffer: await png(40) },
    { name: "back.png", mimeType: "image/png", buffer: await png(200) },
  ]);
  await expect(page.getByTestId("product-photos").getByRole("img")).toHaveCount(2);
  await expect(page.getByTestId("product-photos")).toContainText("Cover");
  const id = page.url().split("/").pop()!;
  await shop.ctx.close();
  const visitor = await browser.newContext();
  const pub = await visitor.newPage();
  await pub.goto(`/shop/${id}`);
  await expect(pub.getByRole("heading", { name })).toBeVisible();
  await expect(pub.getByTestId("product-gallery").getByRole("img")).toHaveCount(2);
  await visitor.close();
});
