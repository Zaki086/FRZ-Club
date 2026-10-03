// v4 §6 e2e step 1 (Cash Drawer v2, §2; the lead runs Playwright) against the seeded sample data, in the style of
// ui-flows.spec.ts: the front desk opens Front Desk Till 1 counting the float by denomination → a member pays ₹550
// in cash (tendered ₹600, change ₹50) → "Cash in drawer now" shows +₹550 → the desk closes with a blind count.
// Setup that is not the step itself (finding a free slot for the member's booking) goes through the API.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PHONE = "9811000001"; // sample persona Rahul Mehta (Gold)

type Session = { ctx: BrowserContext; page: Page };
let desk: Session;

async function loginUi(browser: Browser, identifier: string, password: string): Promise<Session> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/app/);
  return { ctx, page };
}

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

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const inr = (paise: number) => `₹${new Intl.NumberFormat("en-IN").format(Math.floor(paise / 100))}`;

/** The member's booking with two guests, to be paid at the desk (≥ ₹550 due), on the first free slot from `fromDays`
 *  days ahead, inside the member's booking window. */
async function memberBooking(fromDays: number) {
  for (let days = fromDays; days < fromDays + 7; days++) {
    const date = addDays(istToday(), days);
    const avail = await (await desk.ctx.request.get(`/api/availability?date=${date}`)).json();
    const courts = avail.data.dates[0].courts as Array<{ courtId: string; slots: Array<{ time: string; bookable: boolean }> }>;
    for (const c of courts) {
      for (const s of c.slots.filter((x) => x.bookable && x.time >= "10:00")) {
        const res = await desk.ctx.request.post("/api/bookings", {
          data: { courtId: c.courtId, date, startTime: s.time, channel: "FRONT_DESK", players: [{ memberPhone: MEMBER_PHONE }, { guest: { name: "E2E Drawer Guest A" } }, { guest: { name: "E2E Drawer Guest B" } }], payment: { kind: "LATER" } },
        });
        if (res.ok()) return { ...((await res.json()).data as { bookingCode: string; billId: string; total: number }), days };
        const code = (await res.json()).error?.code as string | undefined;
        if (code === "OUTSIDE_BOOKING_WINDOW") throw new Error(`no free slot for the member within the booking window (up to ${date})`);
        if (code === "DAILY_LIMIT_REACHED" || code === "PLAYER_TIME_CONFLICT") break;
      }
    }
  }
  throw new Error("no free slot for the member in the coming days");
}

test.beforeAll(async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD").toBeGreaterThanOrEqual(8);
  desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW);
  // Start from a closed drawer (an earlier run may have left one open): close it at its expected cash.
  const d = await (await desk.ctx.request.get("/api/drawer")).json();
  if (d.data?.open) await desk.ctx.request.post("/api/drawer/close", { data: { cashCounted: d.data.open.cashExpected, floatCarried: Math.min(200000, Math.floor(d.data.open.cashExpected / 100) * 100), note: "e2e start" } });
});

test.afterAll(async () => {
  const d = await (await desk.ctx.request.get("/api/drawer")).json();
  if (d.data?.open) await desk.ctx.request.post("/api/drawer/close", { data: { cashCounted: d.data.open.cashExpected, note: "e2e end" } });
  await desk.ctx.close();
});

test("1. the front desk opens the drawer with a counted float, a member pays ₹550 in cash, the drawer shows +₹550, then a blind close", async () => {
  const page = desk.page;

  // Open Front Desk Till 1: the float is counted by denomination (4 × ₹500 = ₹2,000); the total is computed.
  await page.goto("/app/drawer");
  const opener = page.getByTestId("drawer-opener");
  await expect(opener).toBeVisible();
  await opener.getByLabel("Till").selectOption({ label: "Front Desk Till 1" });
  await opener.getByLabel("₹500 notes", { exact: true }).fill("4");
  await expect(opener.getByTestId("opening-count-total")).toHaveText("₹2,000");
  await opener.getByRole("button", { name: /Open drawer/ }).click();
  await expect(page.getByTestId("cash-in-drawer-amount")).toHaveText("₹2,000");
  const start = (await (await desk.ctx.request.get("/api/drawer")).json()).data.open.balance as number;
  expect(start).toBe(200000);

  // The member's booking (with two guests) is paid ₹550 in cash at the desk: tendered ₹600, change ₹50.
  const b = await memberBooking(1); // the member's plan window (BK-2 step 5) applies to desk bookings too
  expect(b.total).toBeGreaterThanOrEqual(55000);
  await page.goto("/app/courts/bookings");
  for (let i = 0; i < b.days; i++) await page.getByRole("button", { name: "Next day" }).click();
  await page.getByRole("row").filter({ hasText: b.bookingCode }).click();
  const dialog = page.getByTestId("booking-detail");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Amount").first().fill("550");
  const tender = dialog.getByTestId("cash-tender").first();
  await tender.getByRole("button", { name: "Tendered ₹600" }).click();
  await expect(tender.getByTestId("change-due")).toContainText("₹50");
  await dialog.getByTestId("record-payment").click();
  await expect(dialog).toContainText("PARTIAL");

  // The drawer grew by the amount applied (₹550), not by the ₹600 tendered — at once (CD-1).
  await page.goto("/app/drawer");
  await expect(page.getByTestId("cash-in-drawer-amount")).toHaveText(inr(start + 55000));
  await expect(page.getByTestId("stat-sales")).toContainText("₹550");
  const sale = page.getByRole("row").filter({ hasText: "Cash sale" }).first();
  await expect(sale).toContainText("₹550");
  await expect(sale).toContainText(inr(start + 55000));
  const badge = page.getByTestId("drawer-badge-amount");
  if (await badge.count()) await expect(badge).toHaveText(inr(start + 55000));

  // Blind close (CD-5): the count by denomination, without the expected amount on screen; ₹2,000 stays in the till,
  // the rest goes to the safe in a sealed bag (CD-7). Then expected, counted and variance are shown.
  await page.getByRole("button", { name: "Close drawer" }).click();
  const close = page.getByTestId("close-drawer");
  await expect(close).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText(inr(start + 55000));
  for (const [label, n] of countsFor(start + 55000)) await close.getByLabel(label, { exact: true }).fill(n);
  await expect(close.getByTestId("closing-count-total")).toHaveText(inr(start + 55000));
  await close.getByLabel("Float left in the till").fill("2000");
  await close.getByLabel("Sealed bag no.").fill("E2E-V4-DRAWER-1");
  await close.getByRole("button", { name: "Count done — close drawer" }).click();
  const closed = page.getByTestId("drawer-closed");
  await expect(closed).toContainText("no variance");
  await expect(closed).toContainText(inr(start + 55000));
  await expect(page.getByTestId("drawer-opener")).toBeVisible();
});
