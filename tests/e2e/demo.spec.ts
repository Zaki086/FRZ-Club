// §12 judge demo, end to end against the running app (seeded with `npm run seed:demo`).
// The sample club takes cash + card; this run also switches on UPI (as the Owner would after confirming the club's
// UPI ID), opens the staff cash drawers, and puts both back afterwards.
// Logins and key screens run in a real browser; actions go through the same HTTP API the screens call.
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PW = process.env.SEED_MEMBER_PASSWORD ?? "";
let utrSeq = Number(String(Date.now()).slice(-9));
/** A fresh 12-character UPI reference (UTR). */
const utr = () => `9${String(++utrSeq).padStart(11, "0")}`.slice(0, 12);
const CARD = { cardLast4: "4242", approvalCode: "E2E001" };

function istNow() {
  const d = new Date(Date.now() + 330 * 60_000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

async function loginUi(browser: Browser, identifier: string, password: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/(app|portal)/);
  return { ctx, page };
}

type R<T = Record<string, unknown>> = { status: number; data: T; error?: { code: string; message: string } };
async function call<T = Record<string, unknown>>(req: APIRequestContext, method: "GET" | "POST", url: string, body?: unknown, key?: string): Promise<R<T>> {
  const res = await req.fetch(url, { method, data: body, headers: key ? { "Idempotency-Key": key } : undefined });
  const json = (await res.json()) as { data: T; error?: { code: string; message: string } };
  return { status: res.status(), data: json.data, error: json.error };
}

type Avail = { dates: Array<{ courts: Array<{ courtId: string; name: string; slots: Array<{ time: string; bookable: boolean; label: string }> }> }> };

/** A court with `n` consecutive bookable half-hour starts from `from` onwards (on :00). */
async function freeBlock(req: APIRequestContext, date: string, n: number, minStart: number, exclude: string[] = []) {
  const a = await call<Avail>(req, "GET", `/api/availability?date=${date}`);
  for (const c of a.data.dates[0].courts) {
    if (exclude.includes(c.courtId)) continue;
    const slots = c.slots;
    for (let i = 0; i + n <= slots.length; i++) {
      if (toMin(slots[i].time) < minStart || !slots[i].time.endsWith(":00")) continue;
      if (slots.slice(i, i + n).every((s) => s.bookable)) return { courtId: c.courtId, court: c.name, start: slots[i].time };
    }
  }
  throw new Error(`no free block of ${n} slots on ${date}`);
}

let desk: { ctx: BrowserContext; page: Page };
let rahul: { ctx: BrowserContext; page: Page };
let ownerSession: { ctx: BrowserContext; page: Page };
let savedPaymentMethods: unknown = null;
const drawerUsers: Array<{ ctx: BrowserContext; opened: boolean }> = [];

/** Open the staff member's drawer for this run if it isn't open (closed again in afterAll with the expected count). */
async function ensureDrawer(s: { ctx: BrowserContext }, area: string) {
  const d = await call<{ open: unknown }>(s.ctx.request, "GET", "/api/drawer");
  if (d.data.open) return;
  await call(s.ctx.request, "POST", "/api/drawer/open", { area, openingFloat: 0 });
  drawerUsers.push({ ctx: s.ctx, opened: true });
}
const now = istNow();
const demoDate = now.minutes < 15 * 60 ? now.date : addDays(now.date, 1);
const minStart = demoDate === now.date ? Math.ceil((now.minutes + 90) / 60) * 60 : 8 * 60;
const kiranPhone = `98${String(Date.now()).slice(-8)}`;
const S: Record<string, string> = {};

test.beforeAll(async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD (as used by seed:demo)").toBeGreaterThanOrEqual(8);
  ownerSession = await loginUi(browser, "owner@championsclub.example", STAFF_PW);
  const rows = await call<Array<{ key: string; value: unknown }>>(ownerSession.ctx.request, "GET", "/api/settings");
  savedPaymentMethods = rows.data.find((r) => r.key === "payment_methods")?.value ?? null;
  const put = await ownerSession.ctx.request.fetch("/api/settings/payment_methods", { method: "PUT", data: { value: { card_enabled: true, upi_vpa: "e2e.check@upi", upi_confirmed: true } } });
  expect(put.status()).toBe(200);
  desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW);
  await ensureDrawer(desk, "DESK");
  rahul = await loginUi(browser, "9811000001", MEMBER_PW);
});

test.afterAll(async () => {
  for (const u of drawerUsers) {
    const d = await call<{ open: { cashExpected: number } | null }>(u.ctx.request, "GET", "/api/drawer");
    if (d.data.open) await call(u.ctx.request, "POST", "/api/drawer/close", { cashCounted: d.data.open.cashExpected, note: "e2e run" });
  }
  if (ownerSession && savedPaymentMethods) await ownerSession.ctx.request.fetch("/api/settings/payment_methods", { method: "PUT", data: { value: savedPaymentMethods } });
  await ownerSession?.ctx.close();
  await desk?.ctx.close();
  await rahul?.ctx.close();
});

test("1. Front desk signs up Kiran on Silver with UPI → member card QR and a tax invoice", async ({ browser }) => {
  const page = desk.page;
  await page.goto("/app/members/new");
  await page.locator('input[name="name"]').fill("Kiran Desai");
  await page.locator('input[name="phone"]').fill(kiranPhone);
  await page.locator('input[name="dob"]').fill("1996-04-12");
  await page.getByRole("button", { name: /Silver/ }).click();
  await page.locator('select[name="method"]').selectOption("UPI");
  await page.locator('input[name="reference"]').fill(utr());
  await page.getByTestId("member-consent").check();
  await page.getByTestId("signup-submit").click();
  await expect(page.getByText(/is registered as CC-\d{6}/)).toBeVisible();
  await expect(page.getByTestId("member-card")).toBeVisible();
  // v3 WK-1/WK-5: no password at the desk; paying the membership created the login link.
  await expect(page.getByTestId("credentials-panel")).toContainText(kiranPhone);
  const found = await call<Array<{ id: string; status: { tier: string } }>>(desk.ctx.request, "GET", `/api/members?q=${kiranPhone}`);
  S.kiran = found.data[0].id;
  expect(found.data[0].status.tier).toBe("SILVER");
  const inv = await call<Array<{ number: string; kind: string; status: string }>>(ownerSession.ctx.request, "GET", `/api/invoices?memberId=${S.kiran}`);
  expect(inv.data[0]).toMatchObject({ kind: "MEMBERSHIP", status: "PAID" });
  expect(inv.data[0].number).toMatch(/^CC\/\d{4}-\d{2}\/\d{5}$/);
  void browser;
});

test("2. Court booking for Kiran + a walk-in friend: quote ₹150 + ₹400 = ₹550 with explanations", async () => {
  const blk = await freeBlock(desk.ctx.request, demoDate, 4, Math.max(minStart, 17 * 60));
  Object.assign(S, { courtId: blk.courtId, court: blk.court, t0: blk.start, t30: hhmm(toMin(blk.start) + 30), t60: hhmm(toMin(blk.start) + 60) });
  const players = [{ memberId: S.kiran }, { guest: { name: "Kiran's friend" } }];
  const q = await call<{ total: number; players: Array<{ fee: number; explanation: string }> }>(desk.ctx.request, "POST", "/api/bookings/quote", { courtId: S.courtId, date: demoDate, startTime: S.t0, players });
  expect(q.data.players.map((p) => p.fee)).toEqual([15000, 40000]);
  expect(q.data.total).toBe(55000);
  expect(q.data.players[0].explanation).toMatch(/Silver member/);
  expect(q.data.players[1].explanation).toMatch(/Walk-in/);
  const b = await call<{ bookingCode: string; bookingId: string; total: number }>(desk.ctx.request, "POST", "/api/bookings", { courtId: S.courtId, date: demoDate, startTime: S.t0, players, channel: "FRONT_DESK", payment: { kind: "COUNTER", method: "UPI", reference: utr() } }, `demo-${kiranPhone}-1`);
  expect(b.status).toBe(200);
  S.kiranBooking = b.data.bookingId;
  S.kiranCode = b.data.bookingCode;
  await desk.page.goto("/app/courts/bookings");
  await expect(desk.page.getByRole("heading").first()).toBeVisible();
});

test("3. Rahul (member portal) tries the overlapping half hour → SLOT_TAKEN; books the next hour → ₹0 Gold", async () => {
  await rahul.page.goto("/portal/book");
  await expect(rahul.page.getByText(/Book a court/i).first()).toBeVisible();
  const me = await call<{ memberId: string }>(rahul.ctx.request, "GET", "/api/auth/me");
  const overlap = await call(rahul.ctx.request, "POST", "/api/bookings", { courtId: S.courtId, date: demoDate, startTime: S.t30, players: [{ memberId: me.data.memberId }], channel: "ONLINE_MEMBER", payment: { kind: "LATER" } });
  expect(overlap.status).toBe(409);
  expect(overlap.error).toMatchObject({ code: "SLOT_TAKEN" });
  expect(overlap.error!.message).toContain(S.kiranCode);
  const ok = await call<{ total: number; billStatus: string }>(rahul.ctx.request, "POST", "/api/bookings", { courtId: S.courtId, date: demoDate, startTime: S.t60, players: [{ memberId: me.data.memberId }], channel: "ONLINE_MEMBER", payment: { kind: "LATER" } });
  expect(ok.status).toBe(200);
  expect(ok.data.total).toBe(0);
  expect(ok.data.billStatus).toBe("PAID");
});

test("4. Kiran's second session is fine; a third → DAILY_LIMIT_REACHED naming both bookings", async () => {
  const blk = await freeBlock(desk.ctx.request, demoDate, 2, minStart, [S.courtId]);
  const second = await call<{ bookingCode: string }>(desk.ctx.request, "POST", "/api/bookings", { courtId: blk.courtId, date: demoDate, startTime: blk.start, players: [{ memberId: S.kiran }], channel: "PHONE", payment: { kind: "LATER" } });
  expect(second.status).toBe(200);
  const third = await freeBlock(desk.ctx.request, demoDate, 2, minStart, [S.courtId, blk.courtId]);
  const r = await call(desk.ctx.request, "POST", "/api/bookings", { courtId: third.courtId, date: demoDate, startTime: third.start, players: [{ memberId: S.kiran }], channel: "WALK_IN", payment: { kind: "LATER" } });
  expect(r.status).toBe(409);
  expect(r.error!.code).toBe("DAILY_LIMIT_REACHED");
  expect(r.error!.message).toContain(S.kiranCode);
  expect(r.error!.message).toContain(second.data.bookingCode);
});

test("5. npm run demo:race → 20 simultaneous requests, exactly 1 success and 19 SLOT_TAKEN", async () => {
  let out: string;
  try {
    out = execFileSync("npx", ["tsx", "scripts/demo-race.ts"], { encoding: "utf8", env: { ...process.env, APP_URL: test.info().project.use.baseURL as string } });
  } catch (e) {
    // Show what the race printed (a failed run exits non-zero); the assertion below stays the same.
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
  }
  expect(out).toContain("Result: 1 success, 19 SLOT_TAKEN");
});

test("6. Social play: a member and a guest join; a regular booking over it is rejected", async ({ browser }) => {
  const mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
  const blk = await freeBlock(mgr.ctx.request, demoDate, 4, Math.max(minStart, 18 * 60));
  const ses = await call<{ sessions: Array<{ id: string }> }>(mgr.ctx.request, "POST", "/api/social", { title: "Demo Social", courtIds: [blk.courtId], date: demoDate, startTime: blk.start, endTime: hhmm(toMin(blk.start) + 120), capacityPerCourt: 12 });
  expect(ses.status).toBe(200);
  const id = ses.data.sessions[0].id;
  const neha = await call<Array<{ id: string }>>(desk.ctx.request, "GET", "/api/members?q=9811000002");
  const m = await call<{ fee: number }>(desk.ctx.request, "POST", `/api/social/${id}/join`, { player: { memberId: neha.data[0].id }, payment: { kind: "COUNTER", method: "CASH" } }, `soc-m-${kiranPhone}`);
  expect([m.status, m.data.fee]).toEqual([200, 10000]);
  const g = await call<{ fee: number }>(desk.ctx.request, "POST", `/api/social/${id}/join`, { player: { guest: { name: "Social Guest" } }, payment: { kind: "COUNTER", method: "UPI", reference: utr() } }, `soc-g-${kiranPhone}`);
  expect([g.status, g.data.fee]).toEqual([200, 25000]);
  const clash = await call(desk.ctx.request, "POST", "/api/bookings", { courtId: blk.courtId, date: demoDate, startTime: hhmm(toMin(blk.start) + 30), players: [{ guest: { name: "Clasher" } }], channel: "WALK_IN", payment: { kind: "LATER" } });
  expect(clash.status).toBe(409);
  expect(clash.error!.message).toMatch(/social play “Demo Social”/);
  await mgr.ctx.close();
});

test("7. Shop: Rahul orders the last racket online → reserved; the counter can't sell it; low-stock alert", async ({ browser }) => {
  const cat = await call<Array<{ name: string; variants: Array<{ id: string; available: number }> }>>(rahul.ctx.request, "GET", "/api/shop/catalogue?category=RACKETS");
  const racket = cat.data.find((p) => p.name.startsWith("Pro Staff 97"))!;
  expect(racket.variants[0].available).toBe(1);
  const order = await call<{ status: string }>(rahul.ctx.request, "POST", "/api/shop/checkout", { items: [{ variantId: racket.variants[0].id, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" }, `order-${kiranPhone}`);
  expect([order.status, order.data.status]).toEqual([200, "CONFIRMED"]);
  const shop = await loginUi(browser, "shop@championsclub.example", STAFF_PW);
  await ensureDrawer(shop, "SHOP");
  const sale = await call(shop.ctx.request, "POST", "/api/shop/counter-sale", { items: [{ variantId: racket.variants[0].id, qty: 1 }], payments: [{ method: "CARD", ...CARD }] }, `sale-${kiranPhone}`);
  expect(sale.status).toBe(409);
  expect(sale.error).toMatchObject({ code: "INSUFFICIENT_STOCK" });
  expect(sale.error!.message).toMatch(/reserved for online orders/);
  const notes = await call<{ items: Array<{ type: string; title: string }> }>(shop.ctx.request, "GET", "/api/notifications?limit=50");
  expect(notes.data.items.some((n) => n.type === "LOW_STOCK" && n.title.includes("Pro Staff 97"))).toBe(true);
  await shop.page.goto("/app/shop/stock?filter=low");
  await expect(shop.page.getByText(/Pro Staff 97/).first()).toBeVisible();
});

test("8. Bar: Kiran's tab at Table 4 gets 10% off; a beer for Aarav is refused; KDS shows Table 4 · Kiran; split settle", async ({ browser }) => {
  const bar = await loginUi(browser, "bar@championsclub.example", STAFF_PW);
  await ensureDrawer(bar, "BAR");
  const r = bar.ctx.request;
  const tables = await call<{ tables: Array<{ id: string; number: number }> }>(r, "GET", "/api/bar/tables");
  const t4 = tables.data.tables.find((t) => t.number === 4)!;
  const menu = await call<Array<{ id: string; name: string }>>(r, "GET", "/api/bar/menu");
  const id = (n: string) => menu.data.find((m) => m.name === n)!.id;
  const tab = await call<{ tabId: string }>(r, "POST", "/api/bar/tabs", { memberId: S.kiran, tableId: t4.id }, `tab-${kiranPhone}`);
  expect(tab.status).toBe(200);
  const lines = await call<{ lines: Array<{ discountPct: number; explanation: string }>; total: number }>(r, "POST", `/api/bar/tabs/${tab.data.tabId}/lines`, { items: [{ menuItemId: id("Fresh lime soda"), qty: 2 }, { menuItemId: id("Masala fries"), qty: 1, note: "extra spicy" }] });
  expect(lines.data.lines.every((l) => l.discountPct === 10)).toBe(true);
  expect(lines.data.lines[0].explanation).toMatch(/Silver member · 10% bar discount/);
  const aaravId = (await call<Array<{ id: string }>>(r, "GET", "/api/members?q=9811000003")).data[0].id;
  const aTabs = await call<Array<{ id: string; payer: string; status: string }>>(r, "GET", "/api/bar/tabs");
  let aaravTab = aTabs.data.find((t) => t.payer.startsWith("Aarav") && t.status === "OPEN")?.id;
  if (!aaravTab) aaravTab = (await call<{ tabId: string }>(r, "POST", "/api/bar/tabs", { memberId: aaravId }, `tab-a-${kiranPhone}`)).data.tabId;
  const beer = await call(r, "POST", `/api/bar/tabs/${aaravTab}/lines`, { items: [{ menuItemId: id("Kingfisher pint"), qty: 1 }] });
  expect(beer.status).toBe(409);
  expect(beer.error).toMatchObject({ code: "ALCOHOL_NOT_ALLOWED" });
  await call(r, "POST", `/api/bar/tabs/${tab.data.tabId}/send`, {});
  await bar.page.goto("/app/bar/kds");
  await expect(bar.page.getByText(/Kiran/).first()).toBeVisible();
  const kds = await call<Array<{ table: number; payer: string; lines: Array<{ id: string }> }>>(r, "GET", "/api/bar/kds");
  const ticket = kds.data.find((k) => k.payer.startsWith("Kiran"))!;
  expect(ticket.table).toBe(4);
  for (const l of ticket.lines) {
    await call(r, "POST", `/api/bar/lines/${l.id}/status`, { status: "PREPARING" });
    await call(r, "POST", `/api/bar/lines/${l.id}/status`, { status: "READY" });
  }
  const ready = await call<Array<{ payer: string; table: number }>>(r, "GET", "/api/bar/ready");
  expect(ready.data.some((x) => x.payer.startsWith("Kiran") && x.table === 4)).toBe(true);
  const total = lines.data.total;
  const settle = await call<{ status: string; due: number }>(r, "POST", `/api/bar/tabs/${tab.data.tabId}/settle`, { payments: [{ method: "CASH", amount: 20000, tendered: 20000 }, { method: "UPI", amount: total - 20000, reference: utr() }] }, `settle-${kiranPhone}`);
  expect([settle.data.status, settle.data.due]).toEqual(["SETTLED", 0]);
});

test("9. Public site: availability shows Booked; a visitor books a trial → CRM lead + notification; quote → interested → convert", async ({ browser, request }) => {
  const pub = await call<Avail>(request, "GET", `/api/availability?date=${demoDate}`);
  const court = pub.data.dates[0].courts.find((c) => c.courtId === S.courtId)!;
  expect(court.slots.find((s) => s.time === S.t0)!.label).toBe("Booked");
  const visitor = await browser.newContext();
  const vp = await visitor.newPage();
  await vp.goto("/availability");
  await expect(vp.getByText(/Booked/).first()).toBeVisible();
  // Trials follow the walk-in window (today or tomorrow); late in the day the evening is full, so use tomorrow.
  const trialToday = now.minutes < 17 * 60;
  const trialDate = trialToday ? now.date : addDays(now.date, 1);
  const slot = await freeBlock(request, trialDate, 2, trialToday ? Math.ceil((now.minutes + 60) / 60) * 60 : 8 * 60);
  const trialPhone = `97${String(Date.now()).slice(-8)}`;
  const trial = await call<{ bookingCode: string; leadCode: string; fee: number }>(request, "POST", "/api/trial", { consent: true, name: "Visitor Vasu", phone: trialPhone, email: "vasu@example.com", courtId: slot.courtId, date: trialDate, startTime: slot.start });
  expect(trial.status).toBe(200);
  const leads = await call<Array<{ id: string; code: string; source: string }>>(desk.ctx.request, "GET", `/api/crm/leads?q=${trial.data.leadCode}`);
  const lead = leads.data.find((l) => l.code === trial.data.leadCode)!;
  expect(lead.source).toBe("TRIAL_BOOKING");
  const notes = await call<{ items: Array<{ type: string; title: string }> }>(desk.ctx.request, "GET", "/api/notifications?limit=50");
  expect(notes.data.items.some((n) => n.type === "NEW_LEAD" && n.title.includes(trial.data.leadCode))).toBe(true);
  const quote = await call<{ link: string; total: number }>(desk.ctx.request, "POST", `/api/crm/leads/${lead.id}/quote`, { lines: [{ planCode: "SILVER", months: 3 }], send: "LINK" });
  await vp.goto(quote.data.link);
  await vp.getByRole("button", { name: /interested/i }).click();
  await expect(vp.getByText(/thank/i).first()).toBeVisible();
  const conv = await call<{ membershipStatus: string }>(desk.ctx.request, "POST", "/api/members", { name: "Visitor Vasu", phone: trialPhone, dob: "1992-02-02", leadId: lead.id, plan: { code: "SILVER", months: 3, payment: { method: "UPI", reference: utr() } } }, `conv-${trialPhone}`);
  expect(conv.data.membershipStatus).toBe("ACTIVE");
  const after = await call<{ status: string }>(desk.ctx.request, "GET", `/api/crm/leads/${lead.id}`);
  expect(after.data.status).toBe("WON");
  await visitor.close();
});

test("10–11. Owner dashboard Today reconciles; Courts drill-down sums to the KPI; share link; audit shows who did it", async ({ browser, request }) => {
  const owner = ownerSession;
  const r = owner.ctx.request;
  const d = await call<{ money: { collected: { value: number }; bySource: Record<string, { value: number }>; byMethod: Record<string, { value: number }> } }>(r, "GET", "/api/reports/dashboard?period=TODAY");
  const sources = Object.values(d.data.money.bySource).reduce((a, x) => a + x.value, 0);
  const methods = Object.values(d.data.money.byMethod).reduce((a, x) => a + x.value, 0);
  expect(sources).toBe(d.data.money.collected.value);
  expect(methods).toBe(d.data.money.collected.value);
  const dd = await call<{ total: number; rows: Array<{ amount: number }> }>(r, "GET", "/api/reports/drilldown?metric=source:COURTS&period=TODAY");
  expect(dd.data.rows.reduce((a, x) => a + x.amount, 0)).toBe(d.data.money.bySource.COURTS.value);
  expect(d.data.money.bySource.COURTS.value).toBeGreaterThanOrEqual(55000);
  await owner.page.goto("/app");
  await expect(owner.page.getByText(/Collected/i).first()).toBeVisible();
  const link = await call<{ url: string }>(r, "POST", "/api/reports/share-links", { period: "TODAY" });
  const shared = await call<{ summary: string }>(request, "GET", `/api${link.data.url}`);
  expect(shared.status).toBe(200);
  const audit = await call<Array<{ action: string; actorLabel: string }>>(r, "GET", `/api/audit?entity=booking&entityId=${S.kiranBooking}`);
  expect(audit.data.some((a) => a.action === "booking.create" && a.actorLabel.includes("FRONT_DESK"))).toBe(true);
  void browser;
});

test("12. Bar staff opening Finance → 403", async ({ browser }) => {
  const bar = await loginUi(browser, "bar@championsclub.example", STAFF_PW);
  const res = await bar.page.goto("/app/finance/invoices");
  expect(res?.status()).toBe(403);
  await expect(bar.page.getByText(/403/).first()).toBeVisible();
  const api = await call(bar.ctx.request, "GET", "/api/payroll");
  expect(api.status).toBe(403);
  await bar.ctx.close();
});
