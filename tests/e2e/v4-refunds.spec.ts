// v4 §6 e2e steps 2 and 3 (Refunds v2, §3; the lead runs Playwright): against the seeded sample data, in the style of
// ui-flows.spec.ts. Setup that is not a screen (finding a free slot, the desk's booking, the signed /r/ link) goes
// through the API or the database; everything the step is about is done on screen.
//  2. Manager closes a court (wet court) → the affected member gets in-app + push + WhatsApp (API or the manual queue)
//     → member opens /r/<token> → Refund → front desk pays out from the drawer (identity checked) → the member's portal
//     Refunds tab shows Collected, with the receipt.
//  3. Member requests a refund → manager approves from the dashboard panel → member sees "Ready to collect".
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
// WHATSAPP's signer: the link the WhatsApp "Choose option" button carries (v4 §5.3), for the club cancellation read below.
import { signResolutionToken } from "../../src/server/services/signed-links";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PW = process.env.SEED_MEMBER_PASSWORD ?? "";
const MEMBER = { phone: "9811000001", name: "Rahul Mehta" }; // sample persona (Gold), guardian of Aarav
const db = new PrismaClient();

type Session = { ctx: BrowserContext; page: Page };
let desk: Session;
let deskOpenedDrawer = false;

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

/** Open the desk drawer on screen (if it isn't already), with a float that covers the refunds paid out below. */
async function openDrawerUi(s: Session) {
  await s.page.goto("/app/drawer");
  const opener = s.page.getByTestId("drawer-opener");
  const openCard = s.page.getByText(/drawer · open since/i);
  await expect(opener.or(openCard)).toBeVisible();
  if (await opener.isVisible()) {
    // v4 §2.3: choose the till and count the float by denomination.
    await opener.getByLabel("Till").selectOption({ label: "Front Desk Till 1" });
    await opener.getByLabel("₹500 notes", { exact: true }).fill("4");
    await opener.getByRole("button", { name: /Open drawer/ }).click();
    deskOpenedDrawer = true;
  }
  await expect(s.page.getByText(/drawer · open since/i)).toBeVisible();
}

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A free court slot from `fromDays` ahead (the desk's availability), and the member's booking on it (with a guest),
 *  paid in cash at the desk. Days the member can't book (daily limit) are skipped. */
async function deskBooking(fromDays: number) {
  for (let days = fromDays; days < fromDays + 7; days++) {
    const date = addDays(istToday(), days);
    const avail = await (await desk.ctx.request.get(`/api/availability?date=${date}`)).json();
    const courts = avail.data.dates[0].courts as Array<{ courtId: string; name: string; slots: Array<{ time: string; bookable: boolean }> }>;
    for (const c of courts) {
      for (const s of c.slots.filter((x) => x.bookable && x.time >= "16:00")) {
        const res = await desk.ctx.request.post("/api/bookings", {
          data: { courtId: c.courtId, date, startTime: s.time, channel: "FRONT_DESK", players: [{ memberPhone: MEMBER.phone }, { guest: { name: "E2E Refund Guest" } }], payment: { kind: "COUNTER", method: "CASH" } },
        });
        if (res.ok()) {
          const b = (await res.json()).data as { bookingId: string; bookingCode: string; billId: string; total: number };
          return { ...b, date, court: c.name, days };
        }
        const code = (await res.json()).error?.code as string | undefined;
        if (code === "DAILY_LIMIT_REACHED" || code === "PLAYER_TIME_CONFLICT") break; // try the next court / day
      }
    }
  }
  throw new Error("no free slot for the member in the coming days");
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

test.beforeAll(async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD").toBeGreaterThanOrEqual(8);
  desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW, /\/app\/desk/);
  await openDrawerUi(desk);
});

test.afterAll(async () => {
  if (deskOpenedDrawer) {
    const d = await (await desk.ctx.request.get("/api/drawer")).json();
    if (d.data?.open) await desk.ctx.request.post("/api/drawer/close", { data: { cashCounted: d.data.open.cashExpected, note: "v4 refunds e2e" } });
  }
  await db.$disconnect();
});

test("v4 step 2. a wet-court closure → the member refunds from /r/<token> → the desk pays it out from the drawer → Collected in the portal", async ({ browser }) => {
  const b = await deskBooking(6);
  expect(b.total).toBeGreaterThan(0);

  // The Manager closes the court on screen.
  const mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
  await mgr.page.goto("/app/courts");
  for (let i = 0; i < b.days; i++) await mgr.page.getByRole("button", { name: "Next day" }).click();
  await mgr.page.getByRole("button", { name: "Close courts" }).click();
  const dialog = mgr.page.getByRole("dialog");
  await dialog.getByLabel(b.court, { exact: true }).check();
  const row = (await (await desk.ctx.request.get(`/api/lists/bookings?q=${b.bookingCode}`)).json()).data.rows[0] as { start_at: string; end_at: string };
  await dialog.getByLabel("Closed from").selectOption(hhmm(row.start_at));
  await dialog.getByLabel("Closed until").selectOption(hhmm(row.end_at));
  await dialog.getByLabel("Closure reason").selectOption("WET_COURT");
  await dialog.getByLabel("Note for players").fill("Standing water after the rain");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByTestId("closure-preview")).toContainText(b.bookingCode);
  await dialog.getByRole("button", { name: "Close courts and notify" }).click();
  await expect(dialog.getByTestId("closure-done")).toContainText("waiting for the player's choice");
  await mgr.ctx.close();

  // The member is told in the app, by push and on WhatsApp (the API when it is set up, otherwise the desk's queue).
  const member = await db.member.findUniqueOrThrow({ where: { phone: MEMBER.phone } });
  const sent = await db.notificationDelivery.findMany({ where: { memberId: member.id, event: "BOOKING_CANCELLED_BY_CLUB", dedupeKey: { startsWith: "club-cancel:" + b.bookingId } } });
  const by = Object.fromEntries(sent.map((d) => [d.channel, d.status]));
  expect(by.IN_APP).toBe("SENT");
  expect(by.PUSH).toBeTruthy(); // QUEUED/SENT with a subscribed device, SKIPPED (with the reason) without one
  expect([by.WHATSAPP_API, by.WHATSAPP_MANUAL]).toEqual(expect.arrayContaining([expect.stringMatching(/QUEUED|SENT|DELIVERED|READ/)]));

  // The member opens the signed link (no login) and takes the refund.
  const cc = await db.clubCancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
  const token = signResolutionToken(cc.id, cc.deadlineAt);
  const visitor = await browser.newContext();
  const r = await visitor.newPage();
  await r.goto(`/r/${token}`);
  await r.getByTestId("resolution-refund").click();
  await r.getByTestId("resolution-refund-confirm").click();
  const outcome = r.getByTestId("resolution-outcome");
  await expect(outcome).toContainText(/Collect it in cash at the front desk — say refund RF-\d{6}/);
  const code = /RF-\d{6}/.exec((await outcome.textContent()) ?? "")![0];
  await visitor.close();

  // The front desk: Refunds → Pay out a refund → find it → check the person → pay from the drawer → receipt.
  const before = (await (await desk.ctx.request.get("/api/drawer")).json()).data?.open?.cashExpected as number | undefined;
  const page = desk.page;
  await page.goto("/app/refunds");
  await expect(page).toHaveURL(/status=APPROVED/); // "Ready to pay out" is the default tab
  await expect(page.getByRole("row", { name: new RegExp(code) })).toContainText("Ready to collect");
  await page.getByTestId("open-payout").click();
  const pd = page.getByRole("dialog");
  await pd.getByLabel("Find a refund").fill(code);
  await pd.getByRole("button", { name: `Pay out ${code}` }).click();
  const payout = pd.getByTestId("refund-payout");
  await expect(payout.getByTestId("payout-photo")).toBeVisible();
  await expect(payout).toContainText(MEMBER.name);
  const pay = payout.getByRole("button", { name: /^Pay out ₹/ });
  await expect(pay).toBeDisabled(); // RF-9: not before "Identity checked"
  await payout.getByLabel("Identity checked").check();
  await payout.getByLabel("Method").selectOption("CASH");
  await pay.click();
  await expect(pd.getByTestId("refund-paid-out")).toContainText(`${code} is collected`);
  await expect(pd.getByRole("link", { name: "Print refund receipt" })).toHaveAttribute("href", /^\/print\/refund\//);
  const after = (await (await desk.ctx.request.get("/api/drawer")).json()).data?.open?.cashExpected as number | undefined;
  if (typeof before === "number" && typeof after === "number") expect(before - after).toBe(b.total); // the drawer gave the cash
  const req = await db.refundRequest.findUniqueOrThrow({ where: { code } });
  expect([req.status, req.collectStatus, req.identityCheckedBy]).toEqual(["COMPLETED", "COLLECTED", expect.any(String)]);

  // The member's portal: Refunds tab shows it Collected, with the receipt.
  const rahul = await loginUi(browser, MEMBER.phone, MEMBER_PW, /\/portal/);
  await rahul.page.getByRole("link", { name: "Refunds", exact: true }).click();
  await rahul.page.waitForURL(/\/portal\/refunds/);
  const card = rahul.page.getByTestId("my-refund").filter({ hasText: code });
  await expect(card).toContainText("Collected");
  await expect(card.getByTestId("refund-timeline")).toContainText("Ready to collect");
  await card.getByRole("link", { name: "Receipt", exact: true }).click();
  await expect(rahul.page.getByTestId("refund-receipt")).toContainText(code);
  await expect(rahul.page.getByTestId("refund-receipt")).toContainText("Received by (signature)");
  await rahul.ctx.close();
});

test("v4 step 3. the member asks for a refund → the manager approves from the dashboard panel → the member sees Ready to collect", async ({ browser }) => {
  // An item the member may ask for (§3.2: their own cancellation within policy) whose money did not go back
  // automatically — e.g. cancelled before the refund workflow. Booked and paid at the desk, then marked cancelled
  // well before its start (as v3-phase4-refunds "RF-1 (members)" does).
  const b = await deskBooking(7);
  const bk = await db.booking.findUniqueOrThrow({ where: { id: b.bookingId }, select: { reservationId: true } });
  await db.$transaction([
    db.booking.update({ where: { id: b.bookingId }, data: { status: "CANCELLED", cancelledAt: new Date() } }),
    db.courtReservation.update({ where: { id: bk.reservationId }, data: { status: "CANCELLED" } }),
  ]);

  const rahul = await loginUi(browser, MEMBER.phone, MEMBER_PW, /\/portal/);
  await rahul.page.goto("/portal/refunds");
  const item = rahul.page.getByTestId("refund-eligible").filter({ hasText: b.bookingCode });
  await expect(item).toContainText("left to refund"); // RF-11: what is left is shown
  await item.getByRole("button", { name: "Request refund" }).click();
  await item.getByLabel("Note (optional)").fill("Cancelled the day before");
  await item.getByRole("button", { name: "Send request" }).click();
  const card = rahul.page.getByTestId("my-refund").filter({ hasText: b.bookingCode });
  await expect(card).toContainText("Waiting for approval");
  const code = /RF-\d{6}/.exec((await card.textContent()) ?? "")![0];

  // The Manager approves inline in "Needs your approval" on the dashboard.
  const mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
  await mgr.page.goto("/app");
  const ask = mgr.page.getByTestId("approvals-panel").getByTestId("approval-row").filter({ hasText: code });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: /^Approve/ }).click();
  await expect(mgr.page.getByTestId("approval-row").filter({ hasText: code })).toHaveCount(0);
  await mgr.ctx.close();

  // The member sees it ready to collect, on the Refunds tab and the home banner, with the QR.
  await rahul.page.goto("/portal/refunds");
  await expect(rahul.page.getByTestId("my-refund").filter({ hasText: code })).toContainText("Ready to collect");
  await rahul.page.goto("/portal");
  const banner = rahul.page.getByTestId("refund-ready-banner");
  await expect(banner).toContainText("refund ready to collect at the front desk");
  await banner.getByRole("button", { name: "Show QR" }).click();
  await expect(rahul.page.getByTestId("refund-qr-dialog")).toContainText(code);
  await expect(rahul.page.getByTestId("refund-qr-dialog").getByAltText(`Refund QR for ${code}`)).toBeVisible();
  await rahul.ctx.close();

  // Leave the sample data tidy: the desk pays it out (identity checked) so nothing waits from this run.
  const req = await db.refundRequest.findUniqueOrThrow({ where: { code } });
  const res = await desk.ctx.request.post(`/api/refunds/${req.id}/pay-out`, { data: { method: "CASH", identityChecked: true, via: "SEARCH" } });
  expect(res.ok()).toBe(true);
});
