// v4 §5 (WHATSAPP) e2e steps, in the style of ui-flows.spec.ts, against the seeded sample data (no WhatsApp keys on
// the server: everything must work with WhatsApp absent). The lead runs Playwright. Setup that is not a screen (a
// desk booking, closing the court, the signed /r/ link) goes through the API or the database.
//  1. Owner: Settings → WhatsApp shows the connection checks (keys missing → automatic WhatsApp Off) and the template
//     mapping table with every §5.2 template.
//  2. Public trial and enquiry forms have their own unticked "Send me booking and refund updates on WhatsApp" box; an
//     enquiry sent with it ticked stores the consent with a time. The desk's sign-up form has the same box.
//  3. A member turns WhatsApp updates on and off in the portal (Notifications).
//  4. /r/<token>: a forged link is refused; a real one shows the cancelled session, Reschedule picks a free slot, and
//     the page then shows only the outcome (single use).
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signResolutionToken } from "../../src/server/services/signed-links";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PW = process.env.SEED_MEMBER_PASSWORD ?? "";
const MEMBER = { phone: "9811000002", name: "Neha Kapoor" }; // sample persona (Silver)
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

async function openDrawerUi(s: Session) {
  await s.page.goto("/app/drawer");
  const opener = s.page.getByTestId("drawer-opener");
  const openCard = s.page.getByText(/drawer · open since/i);
  await expect(opener.or(openCard)).toBeVisible();
  if (await opener.isVisible()) {
    // v4 §2.3: choose the till and count the float by denomination.
    await opener.getByLabel("Till").selectOption({ label: "Front Desk Till 1" });
    await opener.getByLabel("₹500 notes", { exact: true }).fill("2");
    await opener.getByRole("button", { name: /Open drawer/ }).click();
    deskOpenedDrawer = true;
  }
  await expect(s.page.getByText(/drawer · open since/i)).toBeVisible();
}

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

test.beforeAll(async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD").toBeGreaterThanOrEqual(8);
  desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW, /\/app\/desk/);
});

test.afterAll(async () => {
  if (deskOpenedDrawer) {
    const d = await (await desk.ctx.request.get("/api/drawer")).json();
    if (d.data?.open) await desk.ctx.request.post("/api/drawer/close", { data: { cashCounted: d.data.open.cashExpected, note: "v4 whatsapp e2e" } });
  }
  await db.$disconnect();
});

test("v4-whatsapp 1. Settings → WhatsApp: connection checks and the template table (keys absent → Off)", async ({ browser }) => {
  const owner = await loginUi(browser, "owner@championsclub.example", STAFF_PW);
  await owner.page.goto("/app/settings");
  await owner.page.getByRole("tab", { name: "WhatsApp" }).click();
  await expect(owner.page.getByTestId("wa-capability")).toContainText("Automatic WhatsApp");
  const status = await (await owner.ctx.request.get("/api/whatsapp/status")).json();
  await expect(owner.page.getByTestId("wa-capability")).toContainText(status.data.capability.enabled ? "On" : "Off");
  if (!status.data.envOk) {
    await expect(owner.page.getByTestId("wa-env")).toContainText(/Missing: .*WHATSAPP_ACCESS_TOKEN/);
    await expect(owner.page.getByRole("button", { name: "Check access token" })).toHaveCount(0);
    await expect(owner.page.getByRole("button", { name: "Send test message" })).toBeDisabled();
  }
  await expect(owner.page.getByTestId("wa-webhook")).toContainText("/api/whatsapp/webhook");
  const table = owner.page.getByTestId("wa-templates");
  for (const t of ["club_session_cancelled", "booking_cancelled_refund", "booking_rescheduled", "cancellation_choice_reminder", "refund_ready_to_collect", "refund_completed", "refund_rejected", "refund_unclaimed_reminder", "membership_welcome", "membership_expiring", "dues_reminder"]) {
    await expect(table.getByTestId(`wa-template-${t}`)).toBeVisible();
  }
  // The old card on "Payments & services" now points here.
  await owner.page.getByRole("tab", { name: "Payments & services" }).click();
  await expect(owner.page.getByText(/set up in the WhatsApp tab/)).toBeVisible();
  await owner.ctx.close();
});

test("v4-whatsapp 2. the WhatsApp tick is a separate, unticked box on the trial, enquiry and sign-up forms; it is stored with a time", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/trial");
  await expect(page.getByTestId("whatsapp-opt-in")).not.toBeChecked();
  await expect(page.getByText("Send me booking and refund updates on WhatsApp")).toBeVisible();

  await page.goto("/enquire");
  const phone = `98${String(Date.now()).slice(-8)}`;
  await page.getByLabel("Full name").fill("E2E WhatsApp Enquiry");
  await page.getByLabel("Mobile").fill(phone);
  await expect(page.getByTestId("whatsapp-opt-in")).not.toBeChecked();
  await page.getByTestId("consent").check();
  await page.getByTestId("whatsapp-opt-in").check();
  await page.getByRole("button", { name: "Send enquiry" }).click();
  await expect(page.getByRole("heading", { name: /^Thanks, E2E!/ })).toBeVisible();
  const lead = await db.lead.findFirstOrThrow({ where: { phone }, orderBy: { createdAt: "desc" } });
  expect(lead.whatsappOptInAt).not.toBeNull();
  await ctx.close();

  await desk.page.goto("/app/members/new");
  await expect(desk.page.getByTestId("whatsapp-opt-in")).not.toBeChecked();
  await expect(desk.page.getByTestId("member-consent")).toBeVisible();
});

test("v4-whatsapp 3. a member turns WhatsApp updates on and off in the portal", async ({ browser }) => {
  const m = await loginUi(browser, MEMBER.phone, MEMBER_PW, /\/portal/);
  const initial = (await (await m.ctx.request.get("/api/whatsapp/opt-in")).json()).data.optedIn as boolean;
  await m.page.goto("/portal/notifications");
  const card = m.page.getByTestId("whatsapp-consent");
  await expect(card).toContainText("Send me booking and refund updates on WhatsApp");
  const toggle = card.getByTestId("whatsapp-opt-in-toggle");
  if (initial) await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: !initial });
  await expect(card).toContainText(initial ? /Turned off/ : /Agreed/);
  expect((await (await m.ctx.request.get("/api/whatsapp/opt-in")).json()).data.optedIn).toBe(!initial);
  await toggle.click(); // back as it was
  await expect(toggle).toBeChecked({ checked: initial });
  await m.ctx.close();
});

test("v4-whatsapp 4. /r/<token>: forged links are refused; a real one reschedules once and then shows only the outcome", async ({ browser }) => {
  const visitor = await browser.newContext();
  const r = await visitor.newPage();
  await r.goto("/r/R1.forged.zzzz.notasignature");
  await expect(r.getByTestId("resolution-unavailable")).toContainText("Link not valid");

  // Setup (not the step itself): the member's paid booking a few days ahead, then the Manager closes that court.
  await openDrawerUi(desk);
  let booked: { bookingId: string; bookingCode: string; courtId: string; date: string; startAt: string; endAt: string } | null = null;
  for (let days = 2; days <= 5 && !booked; days++) { // Silver books up to 5 days ahead
    const date = addDays(istToday(), days);
    const avail = await (await desk.ctx.request.get(`/api/availability?date=${date}`)).json();
    for (const c of avail.data.dates[0].courts as Array<{ courtId: string; slots: Array<{ time: string; bookable: boolean }> }>) {
      const slot = c.slots.find((x) => x.bookable && x.time >= "07:00" && x.time <= "09:00");
      if (!slot) continue;
      const res = await desk.ctx.request.post("/api/bookings", { data: { courtId: c.courtId, date, startTime: slot.time, channel: "FRONT_DESK", players: [{ memberPhone: MEMBER.phone }], payment: { kind: "COUNTER", method: "CASH" } } });
      if (res.ok()) {
        const b = (await res.json()).data;
        booked = { bookingId: b.bookingId, bookingCode: b.bookingCode, courtId: c.courtId, date, startAt: b.startAt, endAt: b.endAt };
        break;
      }
    }
  }
  expect(booked, "a free morning slot for the member").not.toBeNull();
  const mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
  const closed = await mgr.ctx.request.post("/api/closures", { data: { courtIds: [booked!.courtId], date: booked!.date, startTime: hhmm(booked!.startAt), endTime: hhmm(booked!.endAt), reason: "WET_COURT", note: "E2E standing water" } });
  expect(closed.ok()).toBe(true);
  await mgr.ctx.close();
  const cc = await db.clubCancellation.findUniqueOrThrow({ where: { bookingId: booked!.bookingId } });
  const token = signResolutionToken(cc.id, cc.deadlineAt);

  // The member opens the WhatsApp button's link without logging in.
  await r.goto(`/r/${token}`);
  await expect(r.getByTestId("resolution-session")).toContainText(booked!.bookingCode);
  await expect(r.getByTestId("resolution-session")).toContainText("Wet court: E2E standing water");
  await expect(r.getByText(`Hi ${MEMBER.name.split(" ")[0]},`)).toBeVisible();
  await expect(r.getByText(MEMBER.phone)).toHaveCount(0); // no personal data beyond the first name
  await r.getByTestId("resolution-reschedule").click();
  const day = r.getByLabel("Day");
  await day.selectOption({ index: 2 });
  const slot = r.getByLabel("Free slot");
  await expect(slot.locator("option").nth(1)).toBeAttached();
  await slot.selectOption({ index: 1 });
  await r.getByTestId("resolution-move").click();
  const outcome = r.getByTestId("resolution-outcome");
  await expect(outcome).toContainText("Moved to a new time");
  await expect(outcome).toContainText(/New booking BK-\d+\. Already paid: nothing more to pay\./);
  // Single use: reloading shows the outcome only.
  await r.reload();
  await expect(r.getByTestId("resolution-outcome")).toBeVisible();
  await expect(r.getByTestId("resolution-choice")).toHaveCount(0);
  expect((await db.clubCancellation.findUniqueOrThrow({ where: { id: cc.id } })).status).toBe("RESCHEDULED");
  await visitor.close();
});
