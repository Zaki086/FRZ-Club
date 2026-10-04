// v6 §1 (LINKS) — URL-1 every message builder's links start with APP_URL · URL-2 Settings shows the public address ·
// URL-4 the repair script's dry-run report (and --apply with audit) on fixture rows · URL-6 Open Graph tags.
// Outbound mail/push is captured; the database is real.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, settleAfterCommit, withTx } from "@/server/db";
import { SYSTEM } from "@/server/rbac/actor";
import { createResetLinkForMember } from "@/server/auth/account";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { flushDeliveries, setChannelTransportsForTests } from "@/server/services/channels";
import { createLead, createQuote } from "@/server/services/crm";
import { formatRepairReport, repairMessageLinks } from "@/server/services/link-repair";
import { previewMessage } from "@/server/services/messages/send";
import { ensureReadyMadeTemplates } from "@/server/services/messages/templates";
import { setMailTransportForTests } from "@/server/services/notifications";
import { clubOpenGraph } from "@/server/services/og";
import { publicUrlStatus } from "@/server/services/public-url";
import { createShareLink, listShareLinks } from "@/server/services/reports";
import { getSettings, writeSettingTx } from "@/server/services/settings";
import { whatsappSetupStatus } from "@/server/services/whatsapp/setup";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book } from "../helpers/booking";
import { approvedRefund } from "../helpers/refunds";

const APP = "https://club.example.in:3443";
const TUNNEL = "https://gentleman-promise-lottery-muslim.trycloudflare.com";
/** Sites a message may legitimately link to that are not the club (wa.me hand-off). */
const EXTERNAL = /^https:\/\/wa\.me\//;

let w: World;
const mails: Array<{ to: string; subject: string; text: string; html?: string }> = [];
const pushes: Array<Record<string, unknown>> = [];
const savedUrl = process.env.APP_URL;

/** Every absolute URL in a text; each must be on APP_URL (or a known external hand-off). */
function badLinks(...texts: Array<string | null | undefined>): string[] {
  const urls = texts.flatMap((t) => (t ?? "").match(/https?:\/\/[^\s"'<>)]+/g) ?? []);
  return urls.filter((u) => !u.startsWith(`${APP}/`) && u !== APP && !EXTERNAL.test(u));
}
const urlsIn = (t: string | null | undefined) => (t ?? "").match(/https?:\/\/[^\s"'<>)]+/g) ?? [];

beforeAll(() => {
  process.env.APP_URL = APP;
});
afterAll(() => {
  process.env.APP_URL = savedUrl;
});
beforeEach(async () => {
  w = await makeWorld();
  await ensureReadyMadeTemplates();
  setCapabilityOverridesForTests({ email: true, push: true });
  mails.length = 0;
  pushes.length = 0;
  setMailTransportForTests({ sendMail: async (m) => void mails.push(m as never) });
  setChannelTransportsForTests({ push: async (_s: unknown, payload: string) => void pushes.push(JSON.parse(payload)) });
});
afterEach(() => {
  setCapabilityOverridesForTests({});
  setMailTransportForTests(null);
  setChannelTransportsForTests({ push: null, fetch: null });
});

describe("URL-1 every link starts with APP_URL", () => {
  it("URL-1: welcome (set-password + portal), refund ready (rq QR), stored deliveries, manual WhatsApp text and emails", async () => {
    // A real walk-in member (no fixture password) → the welcome with the one-time set-password link.
    const m = await makeMember(w, { name: "Link Tester", plan: "GOLD", email: "link.tester@example.com", password: null });
    const ms = await prisma.membership.findFirstOrThrow({ where: { memberId: m.memberId } });
    const rf = await approvedRefund(w, ms.billId!, 10_000);
    await settleAfterCommit();
    const rows = await prisma.notificationDelivery.findMany({ where: { memberId: m.memberId } });
    const welcome = rows.filter((r) => r.event === "MEMBERSHIP_WELCOME");
    expect(welcome.length).toBeGreaterThan(0);
    expect(welcome.some((r) => r.body.includes(`${APP}/set-password/`))).toBe(true);
    expect(welcome.some((r) => r.body.includes(`${APP}/portal`))).toBe(true);
    const refundRows = rows.filter((r) => /REFUND/.test(r.event));
    expect(refundRows.some((r) => `${r.body}\n${r.whatsappText ?? ""}`.includes(`${APP}/rq/`))).toBe(true);
    for (const r of rows) expect(badLinks(r.body, r.whatsappText, r.title, r.link?.startsWith("http") ? r.link : null)).toEqual([]);
    // WhatsApp template parameters (e.g. the welcome's link) are on APP_URL too.
    for (const r of rows) expect(badLinks(...((r.waParams as string[] | null) ?? []))).toEqual([]);
    // Email bodies and push payloads, as sent.
    await flushDeliveries();
    expect(mails.length).toBeGreaterThan(0);
    for (const mail of mails) expect(badLinks(mail.text, mail.html)).toEqual([]);
    expect(mails.some((x) => urlsIn(x.text).some((u) => u.startsWith(`${APP}/`)))).toBe(true);
    for (const p of pushes) expect(String(p.url).startsWith(`${APP}/`)).toBe(true);
    void rf;
  });

  it("URL-1: message templates — {{link}} and portal.url render on APP_URL (WhatsApp, email text + HTML layout)", async () => {
    const m = await makeMember(w, { name: "Render Tester", plan: "GOLD", email: "render@example.com" });
    await book(w, { time: "18:00", players: [{ memberId: m.memberId }] });
    const b = await prisma.booking.findFirstOrThrow({ where: { primaryMemberId: m.memberId } });
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key: "booking_reminder" } });
    const p = await previewMessage(w.actors.MANAGER, { templateId: t.id, context: "BOOKING", recordId: b.id });
    expect(p.link).toBe(`${APP}/portal/bookings/${b.bookingCode}`);
    expect(badLinks(p.rendered.whatsapp?.text, p.rendered.email?.text, p.rendered.email?.html)).toEqual([]);
    // portal.url in a ready-made welcome-style template
    const withPortal = await prisma.messageTemplate.findFirst({ where: { OR: [{ whatsappText: { contains: "{{portal.url}}" } }, { emailBody: { contains: "{{portal.url}}" } }] } });
    if (withPortal) {
      const pp = await previewMessage(w.actors.MANAGER, { templateId: withPortal.id, context: withPortal.context as never, recordId: withPortal.context === "MEMBER" ? m.memberId : b.id }).catch(() => null);
      if (pp) {
        const txt = `${pp.rendered.whatsapp?.text ?? ""}\n${pp.rendered.email?.text ?? ""}`;
        expect(txt).toContain(`${APP}/portal`);
        expect(badLinks(txt, pp.rendered.email?.html)).toEqual([]);
      }
    }
  });

  it("URL-1: quote link, set-password reset link, share link, WhatsApp setup (webhook + button base)", async () => {
    const lead = await createLead(w.actors.FRONT_DESK, { name: "Quote Lead", phone: "9811000101", email: "q@example.com", source: "WALK_IN" });
    const q = await createQuote(w.actors.FRONT_DESK, lead.id, { lines: [{ planCode: "SILVER", months: 3 }], send: "EMAIL" });
    expect(q.url).toBe(`${APP}/quote/${q.token}`);
    expect(q.link).toBe(`/quote/${q.token}`);
    const outbox = await prisma.emailOutbox.findMany({ where: { dedupeKey: `quote:${q.quoteId}` } });
    expect(outbox[0]?.body).toContain(`${APP}/quote/${q.token}`);
    const act = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, type: "QUOTE_SENT" } });
    expect(badLinks(act.note)).toEqual([]);

    const m = await makeMember(w, { name: "Reset Tester", plan: "GOLD" });
    const reset = await createResetLinkForMember(w.actors.FRONT_DESK, m.memberId);
    expect(reset.url.startsWith(`${APP}/set-password/`)).toBe(true);

    const share = await createShareLink(w.actors.OWNER, { period: "MONTH" });
    expect(share.publicUrl).toBe(`${APP}${share.url}`);
    expect((await listShareLinks(w.actors.OWNER)).every((l) => l.publicUrl.startsWith(`${APP}/share/`))).toBe(true);

    const wa = await whatsappSetupStatus(w.actors.OWNER);
    expect(wa.webhook.url).toBe(`${APP}/api/whatsapp/webhook`);
    expect(wa.buttonBase).toBe(`${APP}/`);
  });

  it("URL-1: sitemap.xml and robots.txt use APP_URL", async () => {
    const map = await sitemap();
    expect(map.length).toBeGreaterThan(0);
    expect(map.every((e) => e.url.startsWith(`${APP}/`))).toBe(true);
    const r = await robots();
    if (r.sitemap) expect(r.sitemap).toBe(`${APP}/sitemap.xml`);
  });
});

describe("URL-2 Settings shows the public address", () => {
  it("URL-2: status line with the configured APP_URL; owner only", async () => {
    expect(publicUrlStatus(w.actors.OWNER)).toMatchObject({ url: APP, ok: true });
    process.env.APP_URL = TUNNEL;
    try {
      expect(publicUrlStatus(w.actors.OWNER)).toMatchObject({ url: TUNNEL, ok: false });
      expect(publicUrlStatus(w.actors.OWNER).reason).toMatch(/trycloudflare/);
    } finally {
      process.env.APP_URL = APP;
    }
    expect(() => publicUrlStatus(w.actors.FRONT_DESK)).toThrow();
  });
});

describe("URL-4 messages:repair-links", () => {
  let who: { userId: string | null; memberId: string };
  async function delivery(id: string, status: string, text: string, extra: Record<string, unknown> = {}) {
    await prisma.notificationDelivery.create({
      data: { id, event: "MEMBERSHIP_EXPIRING", dedupeKey: `fx:${id}`, channel: "WHATSAPP_MANUAL", status, title: "Renew", body: text, whatsappText: text, ...who, toAddress: "919800000001", ...extra },
    });
  }

  it("URL-4: dry run reports counts per table/column/old origin and writes nothing; --apply rewrites pending rows with an audit row each", async () => {
    const m = await makeMember(w, { name: "Repair Tester" });
    who = { userId: m.member.userId, memberId: m.memberId };
    await delivery("fx1", "QUEUED", `Renew: ${TUNNEL}/portal/membership`);
    await delivery("fx2", "QUEUED", `Pay: http://38.49.215.124:3200/portal/invoices and ${TUNNEL}/portal`);
    await delivery("fx3", "SENT", `Old but sent: ${TUNNEL}/portal`); // already sent: history stays as it was
    await delivery("fx4", "QUEUED", `Fine: ${APP}/portal · chat https://wa.me/919800000000`);
    await delivery("fx5", "LINK_OPENED", `Opened: ${TUNNEL}/r/tok`, { waParams: ["Asha", `${TUNNEL}/set-password/x`] });
    await prisma.emailOutbox.create({ data: { id: "eml_fx1", to: "a@example.com", subject: "Hi", body: `See http://localhost:3200/orders/t1` } });
    await prisma.emailOutbox.create({ data: { id: "eml_fx2", to: "b@example.com", subject: "Hi", body: `Sent ${TUNNEL}/x`, sentAt: new Date() } });

    const before = await prisma.notificationDelivery.findMany({ orderBy: { id: "asc" }, where: { id: { startsWith: "fx" } } });
    const auditsBefore = await prisma.auditLog.count({ where: { action: "message.links_repaired" } });
    const dry = await repairMessageLinks({ appOrigin: APP });
    expect(dry.applied).toBe(false);
    expect(dry.rowsByTable).toMatchObject({ notification_deliveries: 3, email_outbox: 1 });
    const d = (table: string, column: string, origin: string) => dry.details.find((x) => x.table === table && x.column === column && x.oldOrigin === origin);
    expect(d("notification_deliveries", "whatsapp_text", TUNNEL)).toMatchObject({ rows: 3, links: 3 });
    expect(d("notification_deliveries", "body", "http://38.49.215.124:3200")).toMatchObject({ rows: 1, links: 1 });
    expect(d("notification_deliveries", "wa_params", TUNNEL)).toMatchObject({ rows: 1, links: 1 });
    expect(d("email_outbox", "body", "http://localhost:3200")).toMatchObject({ rows: 1, links: 1 });
    expect(formatRepairReport(dry)).toContain("dry run");
    // Nothing written.
    expect(await prisma.notificationDelivery.findMany({ orderBy: { id: "asc" }, where: { id: { startsWith: "fx" } } })).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: "message.links_repaired" } })).toBe(auditsBefore);

    const applied = await repairMessageLinks({ appOrigin: APP, apply: true });
    expect(applied.rowsByTable).toMatchObject({ notification_deliveries: 3, email_outbox: 1 });
    const after = Object.fromEntries((await prisma.notificationDelivery.findMany({ where: { id: { startsWith: "fx" } } })).map((r) => [r.id, r]));
    expect(after.fx1.whatsappText).toBe(`Renew: ${APP}/portal/membership`);
    expect(after.fx2.body).toBe(`Pay: ${APP}/portal/invoices and ${APP}/portal`);
    expect(after.fx3.body).toBe(`Old but sent: ${TUNNEL}/portal`);
    expect(after.fx4.body).toBe(`Fine: ${APP}/portal · chat https://wa.me/919800000000`);
    expect(after.fx5.waParams).toEqual(["Asha", `${APP}/set-password/x`]);
    expect((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: "eml_fx1" } })).body).toBe(`See ${APP}/orders/t1`);
    expect((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: "eml_fx2" } })).body).toBe(`Sent ${TUNNEL}/x`);
    expect(await prisma.auditLog.count({ where: { action: "message.links_repaired" } })).toBe(auditsBefore + 4);
    // Idempotent: a second run finds nothing.
    const again = await repairMessageLinks({ appOrigin: APP });
    expect(Object.values(again.rowsByTable).reduce((a, n) => a + n, 0)).toBe(0);
  });
});

describe("URL-6 link previews", () => {
  it("URL-6: Open Graph title = club name, description, logo image absolute on APP_URL, metadataBase = APP_URL", async () => {
    const club = (await getSettings()).club;
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "club", { ...club, name: "The Champions Club", logo_url: "/uploads/logo.png" }));
    const og = await clubOpenGraph({ description: "Your quote" });
    expect(og.metadataBase?.toString()).toBe(`${APP}/`);
    expect(og.openGraph).toMatchObject({ siteName: "The Champions Club", title: "The Champions Club", description: "Your quote", images: [{ url: `${APP}/uploads/logo.png` }] });
    expect(og.twitter).toMatchObject({ title: "The Champions Club", images: [`${APP}/uploads/logo.png`] });
    // Without a logo: the club's generated icon, still on APP_URL.
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "club", { ...club, name: "The Champions Club", logo_url: "" }));
    expect((await clubOpenGraph()).openGraph).toMatchObject({ images: [{ url: `${APP}/icon` }] });
  });

  it("URL-6: /quote, /r, /rq, /portal (layout) and the login page a /portal link redirects to carry og tags", async () => {
    const club = (await getSettings()).club;
    await withTx((tx) => writeSettingTx(tx, SYSTEM, "club", { ...club, name: "The Champions Club" }));
    const pages = [
      await import("@/app/(public)/quote/[token]/page"),
      await import("@/app/(public)/r/[token]/page"),
      await import("@/app/(public)/rq/[token]/page"),
    ];
    for (const p of pages) {
      const md = await p.generateMetadata();
      expect(md.openGraph).toMatchObject({ siteName: "The Champions Club", title: "The Champions Club" });
      expect(md.robots).toBeTruthy();
    }
    const login = await import("@/app/(public)/login/page");
    const lm = await login.generateMetadata({ searchParams: Promise.resolve({ returnTo: "/portal/membership" }) });
    expect(lm.openGraph).toMatchObject({ siteName: "The Champions Club", description: expect.stringMatching(/Member portal/) });
    const portal = await import("@/app/(member)/portal/layout");
    expect((await portal.generateMetadata()).openGraph).toMatchObject({ siteName: "The Champions Club" });
  });
});
