// v5 §3.3–3.4 (MSGUI) e2e steps, in the style of ui-flows.spec.ts / v4-*.spec.ts, against the seeded sample data. The
// lead runs Playwright. wa.me never loads for real: the browser context answers it locally and the test reads the link
// the app opened (91 + the mobile, the message URL-encoded). Setup that is not a screen (finding a row whose member can
// get the message, the club's channels) goes through the API; everything the step is about is done on screen.
//  1. Front desk: Renewal & Dues → a row's "Send message" → "Dues reminder" by WhatsApp → the wa.me tab opens with the
//     message → "Mark as sent" → the Message Log shows it Sent.
//  2. Front desk never sees announcement templates (the composer lists transactional ones only) and the server refuses
//     an announcement from the desk (403, MT-4).
//  3. Manager: Members → 3 rows selected → Send message → "Friday social play invitation" by email/push when the club
//     has them (otherwise those channels are hidden: WhatsApp by hand, stepped through with "Send next") → the first
//     recipients rendered → confirm → progress → summary.
//  4. Messages to Send: "Send next" opens the oldest WhatsApp still to send, "Mark as sent", then offers the next one.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const db = new PrismaClient();
const ANNOUNCEMENTS = ["Friday social play invitation", "Club notice (closure / timing change)"];
const WA_LINK = /^https:\/\/wa\.me\/91[6-9]\d{9}\?text=/;

type Session = { ctx: BrowserContext; page: Page };
type Tpl = { id: string; name: string; category: "TRANSACTIONAL" | "ANNOUNCEMENT"; availableChannels: string[] };
let desk: Session;
let mgr: Session;
let target: { id: string; code: string; name: string } | null = null;

async function loginUi(browser: Browser, identifier: string, password: string, lands?: RegExp): Promise<Session> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands ?? /\/(app|portal)/);
  // wa.me is answered locally: the test checks the link, WhatsApp is never contacted.
  await ctx.route(/^https:\/\/(api\.)?wa\.me\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>WhatsApp</title><p>WhatsApp</p>" }));
  return { ctx, page };
}

async function templates(s: Session, context: string, recordId?: string): Promise<Tpl[]> {
  const res = await s.ctx.request.get(`/api/messages/templates?context=${context}${recordId ? `&recordId=${recordId}` : ""}`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).data.templates;
}

/** The wa.me tab a click opens (a blank tab opened in the click, then pointed at the link). */
async function waTab(s: Session, click: () => Promise<void>): Promise<string> {
  const next = s.ctx.waitForEvent("page");
  await click();
  const tab = await next;
  await tab.waitForURL(WA_LINK);
  const url = tab.url();
  await tab.close();
  return url;
}

test.beforeAll(async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
  desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW, /\/app\/desk/);
  mgr = await loginUi(browser, "manager@championsclub.example", STAFF_PW);
});

test.afterAll(async () => {
  await desk?.ctx.close();
  await mgr?.ctx.close();
  await db.$disconnect();
});

test("v5-msgui 1. front desk: Renewal & Dues row → Send message → Dues reminder by WhatsApp → Mark as sent → Message Log", async () => {
  // Setup: a member on Renewal & Dues who can get the Dues reminder on WhatsApp (a mobile, not opted out).
  const list = await (await desk.ctx.request.get("/api/lists/renewals?sort=dues&size=50")).json();
  const rows = list.data.rows as Array<{ id: string; code: string; name: string }>;
  expect(rows.length, "the sample data has members to renew or chase").toBeGreaterThan(0);
  for (const r of rows.slice(0, 20)) {
    const dues = (await templates(desk, "MEMBER", r.id)).find((t) => t.name === "Dues reminder");
    if (dues?.availableChannels.includes("WHATSAPP")) {
      target = r;
      break;
    }
  }
  expect(target, "a Renewal & Dues member with a mobile for WhatsApp").not.toBeNull();
  const m = target!;

  const p = desk.page;
  await p.goto(`/app/desk/expiring?q=${encodeURIComponent(m.code)}`);
  const row = p.getByRole("row").filter({ hasText: m.code });
  await row.getByTestId("send-message").click();
  const dlg = p.getByRole("dialog", { name: "Send message" });
  await expect(dlg.getByTestId("composer-recipient")).toContainText(m.name);
  await dlg.getByRole("radio", { name: "Dues reminder", exact: true }).check();
  // MT-4: no announcement for the front desk.
  for (const name of ANNOUNCEMENTS) await expect(dlg.getByRole("radio", { name, exact: true })).toHaveCount(0);
  await dlg.getByRole("checkbox", { name: "WhatsApp", exact: true }).check();
  for (const name of ["Email", "Push"]) {
    const box = dlg.getByRole("checkbox", { name, exact: true });
    if (await box.count()) await box.uncheck();
  }
  await expect(dlg.getByTestId("preview-WHATSAPP")).toContainText(m.code);

  // Send: the wa.me tab opens with the message (logged LINK_OPENED). Sent within 24 h before (a re-run)? Confirm.
  const results = dlg.getByTestId("composer-results");
  const guard = dlg.getByTestId("duplicate-guard");
  let link = "";
  const first = desk.ctx.waitForEvent("page");
  await dlg.getByTestId("composer-send").click();
  await expect(results.or(guard)).toBeVisible();
  if (await guard.isVisible()) {
    await first.then((t) => t.close()).catch(() => undefined); // the blank tab closed by the app
    link = await waTab(desk, () => guard.getByTestId("duplicate-confirm").click());
  } else {
    const tab = await first;
    await tab.waitForURL(WA_LINK);
    link = tab.url();
    await tab.close();
  }
  expect(link).toMatch(WA_LINK);
  expect(new URL(link).searchParams.get("text")).toContain(m.code);
  const wa = results.getByTestId("result-WHATSAPP_MANUAL");
  await expect(wa).toContainText("WhatsApp opened");
  await wa.getByTestId("composer-mark-sent").click();
  await expect(wa).toContainText("Sent");
  await dlg.getByTestId("composer-done").click();
  await expect(dlg).toHaveCount(0);

  // The Message Log (the desk's Messages to Send screen, unfiltered to Sent today) shows it.
  await p.goto(`/app/messages?channel=WHATSAPP_MANUAL&status=SENT&range=TODAY&q=${encodeURIComponent(m.code)}`);
  const logRow = p.getByRole("row").filter({ hasText: "Dues reminder" }).first();
  await expect(logRow).toContainText(m.name);
  await expect(logRow).toContainText("Sent");
  const d = await db.notificationDelivery.findFirstOrThrow({ where: { memberId: m.id, channel: "WHATSAPP_MANUAL", title: "Dues reminder" }, orderBy: { createdAt: "desc" } });
  expect(d.status).toBe("SENT");
  expect(d.templateCategory).toBe("TRANSACTIONAL");
});

test("v5-msgui 2. front desk never sees announcement templates; sending one is refused", async () => {
  expect(target).not.toBeNull();
  const m = target!;
  // On screen: the composer on the member's page lists transactional templates only.
  await desk.page.goto(`/app/members/${m.id}`);
  await desk.page.getByTestId("send-message").first().click();
  const dlg = desk.page.getByRole("dialog", { name: "Send message" });
  await expect(dlg.getByTestId("composer-templates")).toBeVisible();
  for (const name of ANNOUNCEMENTS) await expect(dlg.getByRole("radio", { name, exact: true })).toHaveCount(0);
  await expect(dlg.getByTestId("composer-templates").getByText("Announcement", { exact: true })).toHaveCount(0);
  await dlg.getByRole("button", { name: "Cancel" }).click();
  // The API agrees (MT-4): the desk's list has no announcement, and sending the Manager's one is a 403.
  expect((await templates(desk, "MEMBER", m.id)).every((t) => t.category === "TRANSACTIONAL")).toBe(true);
  const friday = (await templates(mgr, "MEMBER", m.id)).find((t) => t.name === ANNOUNCEMENTS[0]);
  expect(friday?.category).toBe("ANNOUNCEMENT");
  const refused = await desk.ctx.request.post("/api/messages/send", { data: { templateId: friday!.id, context: "MEMBER", recordId: m.id, channels: ["WHATSAPP"] } });
  expect(refused.status()).toBe(403);
});

test("v5-msgui 3. manager: Members → 3 selected → announcement by email/push (or WhatsApp by hand) → preview → progress → summary", async () => {
  const started = new Date(Date.now() - 5_000);
  const p = mgr.page;
  const q = "981100000"; // the three sample personas (Rahul, Neha, Aarav)
  const rows = (await (await mgr.ctx.request.get(`/api/lists/members?q=${q}`)).json()).data.rows as Array<{ id: string; name: string }>;
  expect(rows.length, "the sample personas").toBeGreaterThanOrEqual(3);
  const ids = rows.slice(0, 3).map((r) => r.id);
  const friday = (await templates(mgr, "MEMBER")).find((t) => t.name === ANNOUNCEMENTS[0])!;
  expect(friday.category).toBe("ANNOUNCEMENT");
  // Email / push when the club has them and at least one of the three can receive them; else WhatsApp by hand.
  const emailPush = friday.availableChannels.filter((c) => c === "EMAIL" || c === "PUSH");
  let usable = false;
  if (emailPush.length) {
    const pv = await mgr.ctx.request.post("/api/messages/bulk/preview", { data: { templateId: friday.id, list: "members", ids, channels: emailPush } });
    usable = pv.ok() && (await pv.json()).data.total > 0;
  }

  await p.goto(`/app/members?q=${q}`);
  const boxes = p.getByTestId("row-select");
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();
  await expect(p.getByTestId("selection-count")).toHaveText("3 selected");
  await p.getByTestId("bulk-send-message").click();
  const dlg = p.getByRole("dialog", { name: "Send message to 3" });
  await dlg.getByRole("radio", { name: ANNOUNCEMENTS[0], exact: true }).check();
  const box = (name: string) => dlg.getByRole("checkbox", { name, exact: true });
  if (usable) {
    for (const c of emailPush) await box(c === "EMAIL" ? "Email" : "Push").check();
    if (await box("WhatsApp").count()) await box("WhatsApp").uncheck();
  } else {
    // The club can't email or push these three: those channels aren't offered at all (or nobody would get them).
    if (!emailPush.includes("EMAIL")) await expect(box("Email")).toHaveCount(0);
    if (!emailPush.includes("PUSH")) await expect(box("Push")).toHaveCount(0);
    for (const c of emailPush) await box(c === "EMAIL" ? "Email" : "Push").uncheck();
    await box("WhatsApp").check();
  }

  // Preview: the first recipients rendered, the count, who is skipped and why.
  const preview = dlg.getByTestId("bulk-preview");
  await expect(preview.getByTestId("bulk-total")).toBeVisible();
  const total = Number(await preview.getByTestId("bulk-total").textContent());
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(3);
  await expect(preview.getByTestId("bulk-sample")).toHaveCount(Math.min(total, 3));
  await expect(preview.getByTestId("bulk-sample").first()).toContainText("Friday social play");
  const again = dlg.getByTestId("bulk-confirm-duplicates");
  if (await again.isVisible()) await again.check(); // an earlier run sent it within 24 h
  await dlg.getByTestId("bulk-confirm").click();

  // Progress, then the summary.
  await expect(dlg.getByTestId("bulk-progress").or(dlg.getByTestId("bulk-summary"))).toBeVisible();
  await expect(dlg.getByTestId("bulk-channels")).toBeVisible();
  if (usable) {
    // Queued for the worker (≤ 1 a second); each recipient's message is in the log with the template.
    const queued = await db.notificationDelivery.findMany({ where: { templateId: friday.id, createdAt: { gte: started }, channel: { in: ["EMAIL", "PUSH"] } } });
    expect(new Set(queued.map((d) => d.recipientKey)).size).toBe(total);
    expect(queued.every((d) => d.templateCategory === "ANNOUNCEMENT" && !!d.bulkId)).toBe(true);
  } else {
    // WhatsApp by hand: "Send next" opens each wa.me link, "Mark as sent", until none is left.
    const manual = dlg.getByTestId("bulk-manual");
    for (let i = 0; i < total; i++) {
      const link = await waTab(mgr, () => manual.getByTestId("bulk-send-next").click());
      expect(link).toMatch(WA_LINK);
      await manual.getByTestId("bulk-mark-sent").click();
      await expect(manual).toContainText(`${i + 1} of ${total} sent`);
    }
    await expect(manual.getByTestId("bulk-send-next")).toHaveCount(0);
    const sent = await db.notificationDelivery.findMany({ where: { templateId: friday.id, createdAt: { gte: started }, channel: "WHATSAPP_MANUAL" } });
    expect(sent.filter((d) => d.status === "SENT")).toHaveLength(total);
  }
  await dlg.getByTestId("bulk-close").click();
  await expect(p.getByTestId("selection-bar")).toHaveCount(0);
});

test("v5-msgui 4. Messages to Send: Send next opens the oldest WhatsApp to send, Mark as sent, then the next", async () => {
  expect(target).not.toBeNull();
  // Setup: one more WhatsApp to send by hand (the desk's own Dues reminder, queued and not opened yet).
  const dues = (await templates(desk, "MEMBER", target!.id)).find((t) => t.name === "Dues reminder")!;
  const res = await desk.ctx.request.post("/api/messages/send", { data: { templateId: dues.id, context: "MEMBER", recordId: target!.id, channels: ["WHATSAPP"], confirmDuplicate: true } });
  expect(res.ok(), await res.text()).toBe(true);
  const queue = async () => (await (await desk.ctx.request.get("/api/lists/notifications?channel=WHATSAPP_MANUAL&status=QUEUED%2CLINK_OPENED&sort=oldest&size=100")).json()).data as { total: number; rows: Array<{ id: string }> };
  const before = await queue();
  expect(before.total).toBeGreaterThan(0);
  const oldest = before.rows[0].id;

  const p = desk.page;
  await p.goto("/app/messages?channel=WHATSAPP_MANUAL&status=QUEUED%2CLINK_OPENED");
  const panel = p.getByTestId("send-next");
  await expect(panel.getByTestId("send-next-left")).toHaveText(String(before.total));
  const link = await waTab(desk, () => panel.getByTestId("send-next-open").click());
  expect(link).toMatch(WA_LINK);
  await expect(panel.getByTestId("send-next-current")).toBeVisible();
  expect((await db.notificationDelivery.findUniqueOrThrow({ where: { id: oldest } })).status).toBe("LINK_OPENED");
  await panel.getByTestId("send-next-mark-sent").click();
  await expect(panel).toContainText("Marked sent");
  expect((await db.notificationDelivery.findUniqueOrThrow({ where: { id: oldest } })).status).toBe("SENT");
  // The next one is offered (or nothing is left).
  if (before.total > 1) await expect(panel.getByTestId("send-next-open")).toBeVisible();
  else await expect(panel.getByTestId("send-next-done")).toBeVisible();
});
