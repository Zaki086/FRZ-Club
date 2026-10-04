// v5 §3 (MSGCORE) ready-made manual messages — template library (MT-1…MT-3), the email layout and announcement
// unsubscribe (§3.2), the composer's server side (MT-4…MT-6, channel availability, wa.me links, duplicate guard) and
// bulk sends (opt-out skipping, ≤ 1 message/second, Messages to Send). Outbound SMTP / push / Meta are captured; the
// database is real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { formatPhone } from "@/lib/validation/contact";
import { prisma, settleAfterCommit, withTx } from "@/server/db";
import { httpStatusFor, isDomainError } from "@/server/errors";
import { SYSTEM } from "@/server/rbac/actor";
import { addLines, openTab } from "@/server/services/bar";
import { billDue } from "@/server/services/bills";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { flushDeliveries, markManualSent, openManualMessage, subscribePush } from "@/server/services/channels";
import { createLead } from "@/server/services/crm";
import { listView } from "@/server/services/filters";
import { createClient, createDraft, issueInvoice } from "@/server/services/invoices";
import { bulkProgress, createBulkSend, listBulkSends, previewBulkSend, processMessageQueue } from "@/server/services/messages/bulk";
import { READY_MADE_TEMPLATES } from "@/server/services/messages/ready-made";
import { setMessagePushSenderForTests } from "@/server/services/messages/delivery";
import { searchRecords } from "@/server/services/messages/records";
import { composerTemplates, previewMessage, sendMessage } from "@/server/services/messages/send";
import { archiveTemplate, createTemplate, ensureReadyMadeTemplates, getTemplate, restoreTemplate, templateLibrary, updateTemplate } from "@/server/services/messages/templates";
import { applyUnsubscribe, signUnsubscribeToken, verifyUnsubscribeToken } from "@/server/services/messages/unsubscribe";
import { unknownVariables, waMeLink } from "@/server/services/messages/variables";
import { setMailTransportForTests } from "@/server/services/notifications";
import { getSettings, updateSetting, writeSettingTx } from "@/server/services/settings";
import { counterSale, checkout } from "@/server/services/shop";
import { setWhatsAppFetchForTests } from "@/server/services/whatsapp/client";
import { WA_TEMPLATES, waDate, waTime } from "@/server/services/whatsapp/templates";
import { book } from "../helpers/booking";
import { makeBar } from "../helpers/bar";
import { makeMember } from "../helpers/members";
import { approvedRefund } from "../helpers/refunds";
import { makeProduct } from "../helpers/shop";
import { makeWorld, utr, type World } from "../helpers/world";

let w: World;
type Mail = { to: string; subject: string; text: string; html: string; headers?: Record<string, string> };
const mails: Mail[] = [];
const pushes: Array<{ endpoint: string; payload: { title: string; body: string; url: string } }> = [];
const CLUB_PHONE = "9825012345";

beforeEach(async () => {
  w = await makeWorld(); // Mon 12 Oct 2026, 10:00 IST
  await ensureReadyMadeTemplates();
  setCapabilityOverridesForTests({ email: true, push: true });
  mails.length = 0;
  pushes.length = 0;
  setMailTransportForTests({ sendMail: async (m) => void mails.push(m as unknown as Mail) });
  setMessagePushSenderForTests(async (sub, payload) => void pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }));
  const club = (await getSettings()).club;
  await updateSetting(SYSTEM, "club", { ...club, phone: CLUB_PHONE, logo_url: "/uploads/club/logo.png" });
});
afterEach(async () => {
  await settleAfterCommit();
  setMailTransportForTests(null);
  setMessagePushSenderForTests(null);
  setWhatsAppFetchForTests(null);
  setCapabilityOverridesForTests({ email: true });
});

const tpl = (key: string) => prisma.messageTemplate.findUniqueOrThrow({ where: { key } });
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
let n = 0;

/** A member with email + mobile (+ `devices` push devices). */
async function person(name: string, opts: { email?: boolean; devices?: number; plan?: "GOLD" | "SILVER" } = {}) {
  n++;
  const m = await makeMember(w, { name, plan: opts.plan ?? "SILVER", email: opts.email === false ? undefined : `member${n}@example.com` });
  for (let i = 0; i < (opts.devices ?? 0); i++) {
    await subscribePush(m.actor, { endpoint: `https://push.example.net/sub/${n}-${i}`, keys: KEYS, userAgent: ANDROID });
  }
  return m;
}
const err = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code: string; message: string; details?: Record<string, unknown> });

describe("v5 §3.1 template library (MT-1, MT-3) and the 18 ready-made templates", () => {
  it("MT-1: saving checks every variable against the template's context (UNKNOWN_TEMPLATE_VARIABLE); each chosen channel needs its text", async () => {
    const O = w.actors.OWNER;
    const base = { name: "Court booked", context: "BOOKING" as const, category: "TRANSACTIONAL" as const, channels: ["WHATSAPP" as const], emailSubject: "", emailBody: "", pushTitle: "", pushBody: "" };
    const e1 = await err(createTemplate(O, { ...base, whatsappText: "Hi {{member.first_name}}, plan {{membership.plan}} at {{club.name}}" }));
    expect(e1).toMatchObject({ code: "UNKNOWN_TEMPLATE_VARIABLE", details: { unknown: ["{{membership.plan}}"], context: "BOOKING" } });
    expect(e1!.message).toContain("{{booking.code}}"); // lists what can be used
    const dues = await tpl("dues_reminder");
    const e2 = await err(updateTemplate(O, dues.id, { ...dues, context: "MEMBER", category: "TRANSACTIONAL", channels: ["WHATSAPP"], whatsappText: "Your booking {{booking.code}}" } as never));
    expect(e2).toMatchObject({ code: "UNKNOWN_TEMPLATE_VARIABLE" });
    await expect(createTemplate(O, { ...base, name: "Announce", context: "GENERAL", whatsappText: "Hi {{member.first_name}}" })).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE_VARIABLE" });
    await expect(createTemplate(O, { ...base, whatsappText: "Hi {{member.first_name}" })).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE_VARIABLE" });
    await expect(createTemplate(O, { ...base, channels: ["EMAIL"], whatsappText: "" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createTemplate(O, { ...base, context: "LEAD", channels: ["PUSH"], whatsappText: "", pushTitle: "Hi", pushBody: "{{lead.first_name}}" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createTemplate(O, { ...base, whatsappText: "x".repeat(701) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createTemplate(O, { ...base, whatsappText: "Hi", waTemplate: "dues_reminder" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); // a member template
    // Valid: version 1 with its version row and an audit row.
    const t = await createTemplate(O, { ...base, whatsappText: "Hi {{member.first_name}}, *{{booking.court}}* {{booking.date}} {{booking.time}} ({{booking.code}}). {{link}}" });
    expect(t).toMatchObject({ version: 1, active: true, key: null, context: "BOOKING", versions: [{ version: 1 }] });
    expect(await prisma.auditLog.count({ where: { action: "message_template.create", entityId: t.id } })).toBe(1);
    await expect(createTemplate(O, { ...base, name: "court BOOKED", whatsappText: "Hi" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { field: "name" } });
    // Only the Owner edits; the Manager reads the library; the front desk does neither.
    await expect(createTemplate(w.actors.MANAGER, { ...base, name: "M", whatsappText: "Hi" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateTemplate(w.actors.FRONT_DESK, t.id, { ...base, whatsappText: "Hi" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const lib = await templateLibrary(w.actors.MANAGER);
    expect(lib.canManage).toBe(false);
    expect(lib.templates).toHaveLength(19);
    await expect(templateLibrary(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("MT-17: the 18 ready-made templates are inserted by migration 0021 idempotently (the same rows as ready-made.ts), active, version 1, valid", async () => {
    const sql = readFileSync(path.resolve(__dirname, "../../prisma/migrations/0021_v5_message_templates/migration.sql"), "utf8");
    const section = sql.split("-- >>> ready-made templates")[1].split("-- <<< ready-made templates")[0];
    const statements = section.split("ON CONFLICT DO NOTHING;").map((s) => s.trim()).filter((s) => s && !/^--/.test(s) || /INSERT/.test(s)).filter((s) => /INSERT/.test(s)).map((s) => `${s}\nON CONFLICT DO NOTHING`);
    expect(statements).toHaveLength(2);
    await prisma.$executeRawUnsafe("TRUNCATE message_template_versions, message_templates CASCADE");
    for (let round = 0; round < 2; round++) for (const s of statements) await prisma.$executeRawUnsafe(s);
    // An Owner's edit survives running it again.
    const dues = await tpl("dues_reminder");
    await updateTemplate(w.actors.OWNER, dues.id, { ...READY_MADE_TEMPLATES[2], whatsappText: `${READY_MADE_TEMPLATES[2].whatsappText}\nSee you soon.` });
    for (const s of statements) await prisma.$executeRawUnsafe(s);
    await ensureReadyMadeTemplates();
    const rows = await prisma.messageTemplate.findMany({ orderBy: { sortOrder: "asc" } });
    expect(rows).toHaveLength(18);
    expect(await prisma.messageTemplateVersion.count()).toBe(19);
    for (const [i, r] of rows.entries()) {
      const want = READY_MADE_TEMPLATES[i];
      expect(r.key).toBe(want.key);
      const content = { name: r.name, context: r.context, category: r.category, channels: r.channels, waTemplate: r.waTemplate, emailSubject: r.emailSubject, emailBody: r.emailBody, pushTitle: r.pushTitle, pushBody: r.pushBody };
      expect(content).toEqual({ name: want.name, context: want.context, category: want.category, channels: want.channels, waTemplate: want.waTemplate, emailSubject: want.emailSubject, emailBody: want.emailBody, pushTitle: want.pushTitle, pushBody: want.pushBody });
      if (want.key !== "dues_reminder") expect([r.key, r.whatsappText, r.version]).toEqual([want.key, want.whatsappText, 1]);
      expect(r.active && !r.archivedAt).toBe(true);
      expect(unknownVariables(r.context as never, [r.whatsappText, r.emailSubject, r.emailBody, r.pushTitle, r.pushBody])).toEqual([]);
    }
    expect((await tpl("dues_reminder")).version).toBe(2);
    // ensureReadyMadeTemplates after a reset gives the same 18 rows.
    await prisma.$executeRawUnsafe("TRUNCATE message_template_versions, message_templates CASCADE");
    expect(await ensureReadyMadeTemplates()).toBe(18);
    expect(await ensureReadyMadeTemplates()).toBe(0);
    expect(await prisma.messageTemplateVersion.count()).toBe(18);
  });

  it("MT-3: an edit is a new version (sends keep theirs); switching off is not; archive hides it — never deleted", async () => {
    const m = await person("Asha Kapoor");
    const D = w.actors.FRONT_DESK;
    const dues = await tpl("dues_reminder");
    const s1 = await sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] });
    expect(s1.version).toBe(1);
    const edited = await updateTemplate(w.actors.OWNER, dues.id, { ...READY_MADE_TEMPLATES[2], whatsappText: "Hi {{member.first_name}}, *{{dues.amount}}* is due. {{link}}" });
    expect(edited.version).toBe(2);
    expect(edited.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(edited.versions[1].whatsappText).toBe(READY_MADE_TEMPLATES[2].whatsappText);
    const off = await updateTemplate(w.actors.OWNER, dues.id, { ...READY_MADE_TEMPLATES[2], whatsappText: "Hi {{member.first_name}}, *{{dues.amount}}* is due. {{link}}", active: false });
    expect([off.version, off.active]).toEqual([2, false]);
    await expect(sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await updateTemplate(w.actors.OWNER, dues.id, { ...READY_MADE_TEMPLATES[2], whatsappText: "Hi {{member.first_name}}, *{{dues.amount}}* is due. {{link}}", active: true });
    const s2 = await sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"], confirmDuplicate: true });
    expect(s2.version).toBe(2);
    const sent = await prisma.notificationDelivery.findMany({ where: { templateId: dues.id }, orderBy: { createdAt: "asc" } });
    expect(sent.map((d) => d.templateVersion)).toEqual([1, 2]);
    expect(sent[1].whatsappText).toMatch(/^Hi Asha, \*₹0\* is due\./);
    // Archive: gone from the composer and the default library, kept with ?archived=1; restore brings it back.
    await archiveTemplate(w.actors.OWNER, dues.id);
    expect((await composerTemplates(D, { context: "MEMBER", recordId: m.memberId })).templates.some((t) => t.id === dues.id)).toBe(false);
    await expect(sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"], confirmDuplicate: true })).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    expect((await templateLibrary(w.actors.OWNER)).templates.some((t) => t.id === dues.id)).toBe(false);
    expect((await templateLibrary(w.actors.OWNER, { archived: "1" })).templates.find((t) => t.id === dues.id)).toMatchObject({ archivedAt: expect.any(String), sends: 2 });
    await expect(updateTemplate(w.actors.OWNER, dues.id, { ...READY_MADE_TEMPLATES[2] })).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await restoreTemplate(w.actors.OWNER, dues.id);
    expect((await getTemplate(w.actors.MANAGER, dues.id))).toMatchObject({ archivedAt: null, active: true, version: 2 });
    // The database refuses deletes (templates) and any change to a version.
    await expect(prisma.messageTemplate.delete({ where: { id: dues.id } })).rejects.toThrow(/hard delete/);
    await expect(prisma.messageTemplateVersion.updateMany({ where: { templateId: dues.id }, data: { whatsappText: "x" } })).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { entityId: dues.id, action: { startsWith: "message_template." } } })).toBe(5);
  });
});

describe("v5 §3.1 MT-2 preview with a real record, rendering per context", () => {
  it("MT-2: a ready-made template previewed with a real member — WhatsApp, the club's email layout (escaped) and push", async () => {
    await updateSetting(SYSTEM, "club", { ...(await getSettings()).club, name: `Riverside "Racquet" <Club> & Bar` });
    const m = await person("Asha Kapoor", { devices: 1 });
    await book(w, { time: "18:00", players: [{ memberId: m.memberId }] }); // unpaid → dues
    const due = (await prisma.bill.findMany({ where: { memberId: m.memberId, closedAt: null } })).reduce((a, b) => a + billDue(b), 0);
    expect(due).toBeGreaterThan(0);
    const dues = await tpl("dues_reminder");
    const p = await previewMessage(w.actors.FRONT_DESK, { templateId: dues.id, context: "MEMBER", recordId: m.memberId });
    expect(p.recipient).toMatchObject({ kind: "MEMBER", name: "Asha Kapoor", phone: `+91 ••••••${m.member.phone.slice(-4)}`, email: expect.stringMatching(/^me•••@example\.com$/), pushDevices: 1 });
    const wa = p.rendered.whatsapp!;
    expect(wa.text).toContain(`Hi Asha, a friendly reminder from Riverside "Racquet" <Club> & Bar: *${formatINR(due)}* is due on your account (member code *${m.member.memberCode}*).`);
    expect(wa.text).toContain("http://localhost:3200/portal/payments");
    expect(wa.text).toContain(`Questions: ${formatPhone(CLUB_PHONE)}`);
    expect(wa.waLink).toBe(waMeLink(`91${m.member.phone}`, wa.text));
    const email = p.rendered.email!;
    expect(email.subject).toBe(`Amount due at Riverside "Racquet" <Club> & Bar: ${formatINR(due)}`);
    expect(email.html).toContain("Riverside &quot;Racquet&quot; &lt;Club&gt; &amp; Bar");
    expect(email.html).not.toContain("<Club>");
    expect(email.html).toContain('<img src="http://localhost:3200/uploads/club/logo.png"');
    expect(email.html).toContain('href="http://localhost:3200/portal/payments"');
    expect(email.html).toContain("1 Test Road, Ahmedabad");
    expect(email.html).toContain(formatPhone(CLUB_PHONE));
    expect(email.html).toContain("You&#39;re receiving this because you&#39;re a member of Riverside");
    expect(email.text).toContain(`See what's due: http://localhost:3200/portal/payments`);
    expect(p.rendered.push).toEqual({ title: `${formatINR(due)} due`, body: `You have ${formatINR(due)} due at Riverside "Racquet" <Club> & Bar. Pay at the front desk — tap for details.` });
    // The Owner's editor previews unsaved text with a real booking; MT-1 applies to the draft too.
    const b = await prisma.booking.findFirstOrThrow({ where: { primaryMemberId: m.memberId }, include: { reservation: true } });
    const draft = { name: "Draft", context: "BOOKING" as const, category: "TRANSACTIONAL" as const, channels: ["WHATSAPP" as const], whatsappText: "{{booking.code}} on {{booking.date}} at {{booking.time}}, {{booking.court}}", emailSubject: "", emailBody: "", pushTitle: "", pushBody: "" };
    const d = await previewMessage(w.actors.OWNER, { draft, recordId: b.id });
    expect(d.rendered.whatsapp!.text).toBe(`${b.bookingCode} on ${waDate(b.reservation.startAt)} at ${waTime(b.reservation.startAt)}–${waTime(b.reservation.endAt)}, Court 1`);
    expect(d.templateId).toBeNull();
    await expect(previewMessage(w.actors.OWNER, { draft: { ...draft, whatsappText: "{{dues.amount}}" }, recordId: b.id })).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE_VARIABLE" });
    await expect(previewMessage(w.actors.FRONT_DESK, { draft, recordId: b.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Record search for the preview picker.
    expect((await searchRecords(w.actors.OWNER, { context: "MEMBER", q: "asha" })).map((r) => r.id)).toEqual([m.memberId]);
    expect((await searchRecords(w.actors.OWNER, { context: "BOOKING", q: b.bookingCode }))[0]).toMatchObject({ id: b.id, label: `${b.bookingCode} · Asha Kapoor` });
  });

  it("MT-2: each context renders its own record: booking, refund, shop order, restring, tab, lead, invoice and general", async () => {
    const m = await person("Ravi Menon", { devices: 1 });
    const M = w.actors.MANAGER;
    const pv = async (key: string, context: string, recordId: string) => {
      const t = await tpl(key);
      return previewMessage(M, { templateId: t.id, context: context as never, recordId });
    };
    // BOOKING
    const bk = await book(w, { time: "18:00", players: [{ memberId: m.memberId }] });
    const b = await prisma.booking.findFirstOrThrow({ where: { primaryMemberId: m.memberId }, include: { reservation: true } });
    const pb = await pv("booking_reminder", "BOOKING", b.id);
    expect(pb.rendered.whatsapp!.text).toContain(`*Court 1*\n*${waDate(b.reservation.startAt)}, ${waTime(b.reservation.startAt)}–${waTime(b.reservation.endAt)}*\nBooking *${b.bookingCode}*`);
    expect(pb.link).toBe(`http://localhost:3200/portal/bookings/${b.bookingCode}`);
    void bk;
    // REFUND (on the paid membership bill)
    const ms = await prisma.membership.findFirstOrThrow({ where: { memberId: m.memberId } });
    const rf = await approvedRefund(w, ms.billId!, 10_000);
    const pr = await pv("refund_ready", "REFUND", rf.id);
    expect(pr.rendered.whatsapp!.text).toContain(`*${formatINR(10_000)}*`);
    expect(pr.rendered.whatsapp!.text).toContain(`*${rf.code}*`);
    // ORDER: a shop order and a restring ticket
    const bag = await makeProduct(w, { name: "Kit bag", category: "ACCESSORIES", price: 150_000, onHand: 2 });
    const o = await checkout(m.actor, { items: [{ variantId: bag.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" });
    const order = await prisma.shopOrder.findFirstOrThrow({ where: { memberId: m.memberId } });
    void o;
    const po = await pv("order_ready", "ORDER", order.id);
    expect(po.rendered.whatsapp!.text).toContain(`your order *${order.code}* is *ready for pickup*`);
    expect(po.link).toBe(`http://localhost:3200/orders/${order.trackToken}`);
    const restring = await makeProduct(w, { name: "Racket restring", category: "SERVICES", price: 80_000, isRestring: true });
    await counterSale(w.actors.SHOP_STAFF, { memberId: m.memberId, items: [{ variantId: restring.variantId, qty: 1 }], payments: [{ method: "UPI", reference: utr() }], restring: { racket: "Wilson Blade 98", notes: "24 kg" } });
    const ticket = await prisma.serviceTicket.findFirstOrThrow({ where: { memberId: m.memberId } });
    const tickets = await composerTemplates(M, { context: "ORDER", recordId: ticket.id });
    expect(tickets.templates[0]).toMatchObject({ key: "restring_ready", recommended: true });
    expect((await pv("restring_ready", "ORDER", ticket.id)).rendered.whatsapp!.text).toContain(`(ticket *${ticket.code}*)`);
    // TAB
    const bar = await makeBar(w);
    const tab = await openTab(w.actors.BAR_STAFF, { memberId: m.memberId });
    await addLines(w.actors.BAR_STAFF, tab.tabId, { items: [{ menuItemId: bar.fries.id, qty: 2 }] });
    const tabBill = await prisma.bill.findFirstOrThrow({ where: { id: (await prisma.tab.findUniqueOrThrow({ where: { id: tab.tabId } })).billId } });
    const pt = await pv("settle_tab", "TAB", tab.tabId);
    expect(pt.rendered.whatsapp!.text).toContain(`is *${formatINR(billDue(tabBill))}*`);
    expect(pt.link).toBe("http://localhost:3200/portal/tab");
    // LEAD (no push: leads have no app)
    const lead = await createLead(w.actors.FRONT_DESK, { name: "Kiran Mehta", phone: "9811000077", email: "kiran@example.com", source: "TRIAL_BOOKING" });
    const leadTemplates = await composerTemplates(M, { context: "LEAD", recordId: lead.id });
    expect(leadTemplates.templates[0]).toMatchObject({ key: "trial_follow_up", recommended: true, availableChannels: ["WHATSAPP", "EMAIL"] });
    const pl = await pv("trial_follow_up", "LEAD", lead.id);
    expect(pl.rendered.whatsapp!.text).toMatch(/^Hi Kiran, thank you for trying /);
    expect(pl.link).toBe("http://localhost:3200/plans");
    expect(pl.rendered.email!.html).toContain("because you asked");
    // INVOICE (a business client's contact; a draft can't be messaged)
    const client = await createClient(w.actors.ACCOUNTANT, { name: "Mumbai Corp", gstin: "27AAPFU0939F1ZV", address: "Nariman Point, Mumbai", contactName: "Ravi Shah", contactEmail: "ravi@example.com", contactPhone: "9811000078" });
    const draft = await createDraft(w.actors.ACCOUNTANT, { businessClientId: client.id, lines: [{ kind: "MANUAL", description: "Corporate court package", qty: 1, unitPrice: 1_180_000 }] });
    await expect(pv("invoice_due", "INVOICE", draft.invoice.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const inv = await issueInvoice(w.actors.ACCOUNTANT, draft.invoice.id);
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    const pi = await pv("invoice_due", "INVOICE", inv.id);
    expect(pi.recipient).toMatchObject({ kind: "CONTACT", name: "Ravi Shah" });
    expect(pi.rendered.whatsapp!.text).toContain(`Hi Ravi, a reminder that invoice *${issued.number}*`);
    expect(pi.rendered.whatsapp!.text).not.toContain("View the invoice"); // no portal for a business client: the line is left out
    // GENERAL: no personal variables, the portal (social page) as link
    const pg = await pv("friday_social", "MEMBER", m.memberId);
    expect(pg.rendered.whatsapp!.text).not.toContain("Ravi");
    expect(pg.link).toBe("http://localhost:3200/portal/social");
    expect(pg.rendered.email!.html).toContain("Unsubscribe from announcements");
  });

  it("MT-2: most relevant first — an unpaid booking suggests the Dues reminder (the booker's member template), then booking templates", async () => {
    const m = await person("Meera Shah");
    await book(w, { time: "18:00", players: [{ memberId: m.memberId }] });
    const b = await prisma.booking.findFirstOrThrow({ where: { primaryMemberId: m.memberId } });
    const fd = await composerTemplates(w.actors.FRONT_DESK, { context: "BOOKING", recordId: b.id });
    expect(fd.templates.slice(0, 2).map((t) => [t.key, t.recommended])).toEqual([["dues_reminder", true], ["booking_reminder", true]]);
    expect(fd.templates.every((t) => t.category === "TRANSACTIONAL")).toBe(true);
    expect(fd.templates.map((t) => t.context)).toEqual(expect.arrayContaining(["BOOKING", "MEMBER"]));
    expect(fd.recipient).toMatchObject({ kind: "MEMBER", name: "Meera Shah" });
    const mgr = await composerTemplates(w.actors.MANAGER, { context: "BOOKING", recordId: b.id });
    expect(mgr.templates.filter((t) => t.category === "ANNOUNCEMENT").map((t) => t.key).sort()).toEqual(["club_notice", "friday_social"]);
    // The Dues reminder sent from the booking goes to the member with the member's values.
    const dues = await tpl("dues_reminder");
    const s = await sendMessage(w.actors.FRONT_DESK, { templateId: dues.id, context: "BOOKING", recordId: b.id, channels: ["WHATSAPP"] });
    expect(s.recipient.id).toBe(m.memberId);
    expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { id: s.results[0].deliveryId } })).recordId).toBe(m.memberId);
  });
});

describe("v5 §3.3 sending: channels, wa.me, email, push, roles, the log, duplicates", () => {
  it("MT-7: only channels the club has and the recipient can receive are offered — the server rejects the others (CHANNEL_NOT_AVAILABLE)", async () => {
    const a = await person("Asha Kapoor", { devices: 1 });
    const b = await person("Bina Rao", { email: false });
    await prisma.member.update({ where: { id: b.memberId }, data: { whatsappOptInAt: new Date(clock.now().getTime() - 86_400_000), whatsappOptOutAt: clock.now() } });
    const D = w.actors.FRONT_DESK;
    const dues = await tpl("dues_reminder");
    const forA = (await composerTemplates(D, { context: "MEMBER", recordId: a.memberId })).templates.find((t) => t.key === "dues_reminder")!;
    expect(forA.availableChannels).toEqual(["WHATSAPP", "EMAIL", "PUSH"]);
    expect(forA.autoWhatsApp).toBe(false);
    const forB = (await composerTemplates(D, { context: "MEMBER", recordId: b.memberId })).templates.find((t) => t.key === "dues_reminder")!;
    expect(forB.availableChannels).toEqual([]);
    expect(forB.channelOptions).toEqual([
      { channel: "WHATSAPP", available: false, reason: "Opted out of WhatsApp (replied STOP)" },
      { channel: "EMAIL", available: false, reason: "No email address" },
      { channel: "PUSH", available: false, reason: "No device has turned on notifications" },
    ]);
    for (const ch of ["WHATSAPP", "EMAIL", "PUSH"] as const) {
      await expect(sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: b.memberId, channels: [ch] })).rejects.toMatchObject({ code: "CHANNEL_NOT_AVAILABLE", details: { channel: ch } });
    }
    expect(await prisma.notificationDelivery.count({ where: { templateId: dues.id } })).toBe(0);
    // Capabilities off → not offered, refused.
    setCapabilityOverridesForTests({ email: false, push: false });
    const off = (await composerTemplates(D, { context: "MEMBER", recordId: a.memberId })).templates.find((t) => t.key === "dues_reminder")!;
    expect(off.availableChannels).toEqual(["WHATSAPP"]);
    expect(off.channelOptions[1].reason).toMatch(/^Email is not set up/);
    await expect(sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: a.memberId, channels: ["EMAIL"] })).rejects.toMatchObject({ code: "CHANNEL_NOT_AVAILABLE" });
    setCapabilityOverridesForTests({ email: true, push: true });
    // The member turned push off; automatic WhatsApp isn't set up; a lead template has no push.
    await prisma.user.update({ where: { id: a.member.userId! }, data: { notifyPush: false } });
    await expect(sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: a.memberId, channels: ["PUSH"] })).rejects.toMatchObject({ code: "CHANNEL_NOT_AVAILABLE", details: { reason: "Turned off push notifications" } });
    await expect(sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: a.memberId, channels: ["WHATSAPP"], autoWhatsApp: true })).rejects.toMatchObject({ code: "CHANNEL_NOT_AVAILABLE", details: { auto: true } });
    const lead = await createLead(D, { name: "Kiran Mehta", phone: "9811000077", source: "PHONE" });
    await expect(sendMessage(D, { templateId: (await tpl("trial_follow_up")).id, context: "LEAD", recordId: lead.id, channels: ["PUSH"] })).rejects.toMatchObject({ code: "CHANNEL_NOT_AVAILABLE" });
    await expect(sendMessage(D, { templateId: (await tpl("trial_follow_up")).id, context: "LEAD", recordId: lead.id, channels: ["EMAIL"] })).rejects.toMatchObject({ code: "CHANNEL_NOT_AVAILABLE", details: { reason: "No email address" } });
    // A template from another context can't be sent from this record.
    await expect(sendMessage(D, { templateId: (await tpl("trial_follow_up")).id, context: "MEMBER", recordId: a.memberId, channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("MT-8: manual WhatsApp — wa.me/91<phone>?text=<URL-encoded>; opening records LINK_OPENED, Mark as sent records SENT", async () => {
    const m = await person("Asha Kapoor");
    const D = w.actors.FRONT_DESK;
    const s = await sendMessage(D, { templateId: (await tpl("membership_expiring")).id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] });
    expect(s.results).toHaveLength(1);
    const r = s.results[0];
    const row = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: r.deliveryId } });
    expect([r.channel, r.status, row.status, row.toAddress]).toEqual(["WHATSAPP_MANUAL", "QUEUED", "QUEUED", `91${m.member.phone}`]);
    expect(r.waLink).toBe(`https://wa.me/91${m.member.phone}?text=${encodeURIComponent(row.whatsappText!)}`);
    expect(decodeURIComponent(r.waLink!.split("?text=")[1])).toBe(row.whatsappText);
    expect(row.whatsappText).toMatch(/^Hi Asha, your \*Silver\* membership at The Champions Club ends on \*\d+ \w{3} \d{4}\*\./);
    expect(r.waLink).toContain("%0A");
    const opened = await openManualMessage(D, r.deliveryId);
    expect(opened.url).toBe(r.waLink);
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: r.deliveryId } })).status).toBe("LINK_OPENED");
    expect(await prisma.messageLog.count({ where: { channel: "WHATSAPP", status: "OPENED", to: `91${m.member.phone}` } })).toBe(1);
    await markManualSent(D, r.deliveryId);
    expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: r.deliveryId } })).toMatchObject({ status: "SENT", handledBy: D.userId });
  });

  it("MT-9: email goes out now in the club layout (SENT, or FAILED with the reason); push goes to each device", async () => {
    const m = await person("Asha Kapoor", { devices: 2 });
    const D = w.actors.FRONT_DESK;
    const t = await tpl("membership_expiring");
    const s = await sendMessage(D, { templateId: t.id, context: "MEMBER", recordId: m.memberId, channels: ["EMAIL", "PUSH"] });
    expect(s.results.map((r) => [r.channel, r.status, r.device ?? null])).toEqual([["EMAIL", "SENT", null], ["PUSH", "SENT", "Chrome on Android"], ["PUSH", "SENT", "Chrome on Android"]]);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(m.member.email);
    expect(mails[0].subject).toMatch(/^Your The Champions Club membership ends on \d+ \w{3} \d{4}$/);
    expect(mails[0].html).toContain('href="http://localhost:3200/portal/membership"');
    expect(mails[0].html).toContain("Renew my membership");
    expect(mails[0].text).toContain("Hi Asha,");
    expect(mails[0].headers).toBeUndefined(); // transactional: no unsubscribe
    expect(`${mails[0].html}${mails[0].text}`).not.toMatch(/unsubscribe/i);
    expect(pushes.map((p) => p.endpoint).sort()).toEqual([`https://push.example.net/sub/${n}-0`, `https://push.example.net/sub/${n}-1`]);
    expect(pushes[0].payload).toMatchObject({ title: expect.stringMatching(/^Membership ends /), url: "http://localhost:3200/portal/membership" });
    expect(await prisma.messageLog.count({ where: { channel: "EMAIL", status: "SENT", entity: "message_template", entityId: t.id } })).toBe(1);
    // SMTP refuses → FAILED with the reason (and the message log says so); a dead device is forgotten (NT-9).
    setMailTransportForTests({ sendMail: async () => { throw Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 }); } });
    setMessagePushSenderForTests(async () => { throw Object.assign(new Error("Gone"), { statusCode: 410 }); });
    const f = await sendMessage(D, { templateId: t.id, context: "MEMBER", recordId: m.memberId, channels: ["EMAIL", "PUSH"], confirmDuplicate: true });
    expect(f.results.map((r) => [r.channel, r.status])).toEqual([["EMAIL", "FAILED"], ["PUSH", "FAILED"], ["PUSH", "FAILED"]]);
    expect(f.results[0].error).toBe("550 mailbox unavailable");
    expect(await prisma.messageLog.count({ where: { channel: "EMAIL", status: "FAILED", entityId: t.id } })).toBe(1);
    expect(await prisma.pushSubscription.count({ where: { userId: m.member.userId! } })).toBe(0);
  });

  it("MT-10: announcements carry a signed one-click unsubscribe link (+ List-Unsubscribe); transactional emails don't; the link works", async () => {
    const m = await person("Asha Kapoor");
    const M = w.actors.MANAGER;
    const social = await tpl("friday_social");
    await sendMessage(M, { templateId: social.id, context: "MEMBER", recordId: m.memberId, channels: ["EMAIL"] });
    expect(mails).toHaveLength(1);
    const link = /href="(http:\/\/localhost:3200\/unsubscribe\/([^"]+))"/.exec(mails[0].html)!;
    expect(link[2]).toMatch(new RegExp(`^UN1\\.m\\.${m.memberId}\\.[A-Za-z0-9_-]{32}$`));
    expect(mails[0].text).toContain(`Unsubscribe from announcements: ${link[1]}`);
    expect(mails[0].headers).toEqual({ "List-Unsubscribe": `<http://localhost:3200/api/messages/unsubscribe?t=${encodeURIComponent(link[2])}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(mails[0].html).toContain("You&#39;re receiving this because you&#39;re a member of The Champions Club.");
    // Transactional: no link, no header.
    await sendMessage(M, { templateId: (await tpl("dues_reminder")).id, context: "MEMBER", recordId: m.memberId, channels: ["EMAIL"] });
    expect(`${mails[1].html}${mails[1].text}`).not.toMatch(/unsubscribe/i);
    expect(mails[1].headers).toBeUndefined();
    // One click unsubscribes (audited); announcements stop offering email to them, transactional emails still go.
    await expect(applyUnsubscribe(link[2].replace(/.$/, (c) => (c === "A" ? "B" : "A")))).rejects.toMatchObject({ code: "LINK_INVALID" });
    expect(await applyUnsubscribe(decodeURIComponent(link[2]))).toMatchObject({ unsubscribed: true, firstName: "Asha", clubName: "The Champions Club" });
    expect(await prisma.member.findUniqueOrThrow({ where: { id: m.memberId } })).toMatchObject({ emailAnnouncementsOptOut: true, emailAnnouncementsOptOutAt: clock.now() });
    expect(await prisma.auditLog.count({ where: { action: "email.announcements_unsubscribe", entityId: m.memberId } })).toBe(1);
    await applyUnsubscribe(link[2]); // again: idempotent, no second audit row
    expect(await prisma.auditLog.count({ where: { action: "email.announcements_unsubscribe", entityId: m.memberId } })).toBe(1);
    const list = (await composerTemplates(M, { context: "MEMBER", recordId: m.memberId })).templates;
    expect(list.find((t) => t.key === "friday_social")!.channelOptions.find((o) => o.channel === "EMAIL")).toEqual({ channel: "EMAIL", available: false, reason: "Unsubscribed from announcement emails" });
    expect(list.find((t) => t.key === "membership_expiring")!.availableChannels).toContain("EMAIL");
    await expect(sendMessage(M, { templateId: social.id, context: "MEMBER", recordId: m.memberId, channels: ["EMAIL"], confirmDuplicate: true })).rejects.toMatchObject({ code: "CHANNEL_NOT_AVAILABLE" });
    expect(await applyUnsubscribe(link[2], { resubscribe: true })).toMatchObject({ unsubscribed: false });
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.memberId } })).emailAnnouncementsOptOut).toBe(false);
    // Leads get their own token kind.
    expect(verifyUnsubscribeToken(signUnsubscribeToken("l", "lead_1"))).toEqual({ kind: "l", id: "lead_1" });
    expect(verifyUnsubscribeToken("UN1.m.x.forged")).toBeNull();
  });

  it("MT-4/MT-5: the front desk sends transactional templates only — announcements are 403 (FORBIDDEN), individually and in bulk", async () => {
    const m = await person("Asha Kapoor");
    const D = w.actors.FRONT_DESK;
    const social = await tpl("friday_social");
    const fd = await composerTemplates(D, { context: "MEMBER", recordId: m.memberId });
    expect(fd.templates.some((t) => t.category === "ANNOUNCEMENT")).toBe(false);
    const e = await err(sendMessage(D, { templateId: social.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] }));
    expect(e).toMatchObject({ code: "FORBIDDEN" });
    expect(isDomainError(e) && httpStatusFor(e.code)).toBe(403);
    await expect(previewMessage(D, { templateId: social.id, context: "MEMBER", recordId: m.memberId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createBulkSend(D, { templateId: social.id, list: "renewals", ids: [m.memberId], channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(previewBulkSend(D, { templateId: social.id, list: "renewals", ids: [m.memberId], channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The Members list is the Manager's; other roles can't send at all.
    const dues = await tpl("dues_reminder");
    await expect(createBulkSend(D, { templateId: dues.id, list: "members", ids: [m.memberId], channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sendMessage(w.actors.SHOP_STAFF, { templateId: dues.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(composerTemplates(w.actors.BAR_STAFF, { context: "MEMBER", recordId: m.memberId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Allowed: transactional to one person and in bulk from Renewal & Dues; the Manager also announcements.
    expect((await sendMessage(D, { templateId: dues.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] })).results[0].status).toBe("QUEUED");
    expect((await createBulkSend(D, { templateId: (await tpl("membership_expiring")).id, list: "renewals", ids: [m.memberId], channels: ["WHATSAPP"] })).total).toBe(1);
    expect((await sendMessage(w.actors.MANAGER, { templateId: social.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] })).results[0].channel).toBe("WHATSAPP_MANUAL");
    // A [[fill-in]] part must be written first; edits for one send don't change the template.
    const notice = await tpl("club_notice");
    await expect(sendMessage(w.actors.MANAGER, { templateId: notice.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { field: "overrides" } });
    await expect(sendMessage(w.actors.MANAGER, { templateId: notice.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"], overrides: { whatsappText: "Hi {{member.first_name}}" } })).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE_VARIABLE" });
    const ok = await sendMessage(w.actors.MANAGER, { templateId: notice.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"], overrides: { whatsappText: "Notice from {{club.name}}: *Courts 1 and 2 are closed on Sunday 18 Oct, 6–10 am*, for resurfacing." } });
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: ok.results[0].deliveryId } })).whatsappText).toBe("Notice from The Champions Club: *Courts 1 and 2 are closed on Sunday 18 Oct, 6–10 am*, for resurfacing.");
    expect((await tpl("club_notice")).whatsappText).toBe(READY_MADE_TEMPLATES[17].whatsappText);
  });

  it("MT-6: every send is in notification_deliveries / the Message Log — template + version, rendered text, channel, masked recipient, sent by, status", async () => {
    const m = await person("Asha Kapoor", { devices: 1 });
    const D = w.actors.FRONT_DESK;
    const t = await tpl("dues_reminder");
    const s = await sendMessage(D, { templateId: t.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP", "EMAIL", "PUSH"] });
    const rows = await prisma.notificationDelivery.findMany({ where: { sendId: s.sendId }, orderBy: { channel: "asc" } });
    expect(rows.map((r) => [r.channel, r.status])).toEqual([["EMAIL", "SENT"], ["PUSH", "SENT"], ["WHATSAPP_MANUAL", "QUEUED"]]);
    for (const r of rows) {
      expect(r).toMatchObject({ event: "TEMPLATE_MESSAGE", templateId: t.id, templateVersion: 1, templateContext: "MEMBER", templateCategory: "TRANSACTIONAL", recordId: m.memberId, recipientKey: `member:${m.memberId}`, memberId: m.memberId, triggeredBy: D.userId });
      expect(r.body.length).toBeGreaterThan(10);
      expect(r.body).not.toContain("{{");
    }
    expect(rows[0].toMasked).toMatch(/^me•••@example\.com$/);
    expect(rows[1].toMasked).toBe("Chrome on Android");
    expect(rows[2].toMasked).toBe(`+91 ••••••${m.member.phone.slice(-4)}`);
    expect(await prisma.auditLog.count({ where: { action: "message.send", entityId: t.id } })).toBe(1);
    // The Message Log (owner / manager / front desk): filter by type, the template and version, the masked recipient.
    const log = await listView(D, "notifications", { type: "TEMPLATE_MESSAGE" });
    expect(log.total).toBe(3);
    for (const r of log.rows) expect(r).toMatchObject({ template_name: "Dues reminder", template_version: 1, triggered_by_name: "Farah Desk", recipient: "Asha Kapoor", event: "TEMPLATE_MESSAGE" });
    expect(log.rows.map((r) => r.to_address).sort()).toEqual([rows[0].toMasked, rows[1].toMasked, rows[2].toMasked].sort());
    expect(log.facets.find((f) => f.key === "message_template")!.options).toEqual([{ value: t.id, label: "Dues reminder", count: 3 }]);
    const csv = (await listView(w.actors.OWNER, "notifications", { message_template: t.id })).rows;
    expect(csv).toHaveLength(3);
  });

  it("MT-15: duplicate guard — the same template to the same person within 24 h asks for confirmation (DUPLICATE_RECENT_SEND)", async () => {
    const m = await person("Asha Kapoor");
    const D = w.actors.FRONT_DESK;
    const t = await tpl("dues_reminder");
    const send = (extra: Record<string, unknown> = {}) => sendMessage(D, { templateId: t.id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"], ...extra });
    await send();
    clock.advance(30 * 60_000);
    const e = await err(send());
    expect(e).toMatchObject({ code: "DUPLICATE_RECENT_SEND", details: { lastSentAt: expect.any(String), sentBy: "Farah Desk" } });
    expect(e!.message).toBe(`"Dues reminder" was already sent to Asha Kapoor 30 minutes ago by Farah Desk. Send it again?`);
    expect((await composerTemplates(D, { context: "MEMBER", recordId: m.memberId })).templates.find((x) => x.key === "dues_reminder")!.lastSentAt).toBe(new Date(clock.now().getTime() - 30 * 60_000).toISOString());
    await send({ confirmDuplicate: true });
    // Another template is not a duplicate; after 24 h it isn't either.
    await sendMessage(D, { templateId: (await tpl("membership_expiring")).id, context: "MEMBER", recordId: m.memberId, channels: ["WHATSAPP"] });
    clock.advance(24 * 3_600_000);
    await send();
    // A failed email doesn't count as sent.
    setMailTransportForTests({ sendMail: async () => { throw new Error("connection refused"); } });
    const t2 = await tpl("welcome_portal");
    expect((await sendMessage(D, { templateId: t2.id, context: "MEMBER", recordId: m.memberId, channels: ["EMAIL"] })).results[0].status).toBe("FAILED");
    setMailTransportForTests({ sendMail: async (x) => void mails.push(x as unknown as Mail) });
    expect((await sendMessage(D, { templateId: t2.id, context: "MEMBER", recordId: m.memberId, channels: ["EMAIL"] })).results[0].status).toBe("SENT");
  });

  it("MT-16: automatic WhatsApp is offered only with the API on, an approved Meta template mapped and the person opted in — and goes through the v4 queue", async () => {
    const env = { WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_GRAPH_API_VERSION: "v23.0" };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const a = await person("Asha Kapoor");
      const b = await person("Bina Rao");
      await book(w, { time: "18:00", players: [{ memberId: a.memberId }] });
      setCapabilityOverridesForTests({ email: true, push: true, "whatsapp.api": true });
      const map = Object.fromEntries(Object.keys(WA_TEMPLATES).map((t) => [t, { name: t, language: "en", status: "APPROVED", checked_at: null }]));
      await withTx((tx) => writeSettingTx(tx, SYSTEM, "whatsapp_template_map", map));
      await prisma.member.update({ where: { id: a.memberId }, data: { whatsappOptInAt: clock.now() } });
      const calls: Array<{ to: string; template: string; params: string[] }> = [];
      setWhatsAppFetchForTests((async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { to: string; template: { name: string; components?: Array<{ type: string; parameters: Array<{ text: string }> }> } };
        calls.push({ to: body.to, template: body.template.name, params: body.template.components?.find((c) => c.type === "body")?.parameters.map((p) => p.text) ?? [] });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.T1" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch);
      const D = w.actors.FRONT_DESK;
      const listA = (await composerTemplates(D, { context: "MEMBER", recordId: a.memberId })).templates;
      expect(listA.find((t) => t.key === "dues_reminder")!.autoWhatsApp).toBe(true);
      expect(listA.find((t) => t.key === "membership_expired")!.autoWhatsApp).toBe(false); // no Meta template
      expect((await composerTemplates(D, { context: "MEMBER", recordId: b.memberId })).templates.find((t) => t.key === "dues_reminder")!.autoWhatsApp).toBe(false); // not opted in
      await expect(sendMessage(D, { templateId: (await tpl("dues_reminder")).id, context: "MEMBER", recordId: b.memberId, channels: ["WHATSAPP"], autoWhatsApp: true })).rejects.toMatchObject({ code: "CHANNEL_NOT_AVAILABLE" });
      const s = await sendMessage(D, { templateId: (await tpl("dues_reminder")).id, context: "MEMBER", recordId: a.memberId, channels: ["WHATSAPP"], autoWhatsApp: true });
      expect(s.results[0]).toMatchObject({ channel: "WHATSAPP_API", status: "QUEUED" });
      await settleAfterCommit();
      const due = (await prisma.bill.findMany({ where: { memberId: a.memberId, closedAt: null } })).reduce((x, y) => x + billDue(y), 0);
      expect(calls).toEqual([{ to: `91${a.member.phone}`, template: "dues_reminder", params: ["Asha", formatINR(due).replace("₹", ""), "your club account"] }]);
      expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: s.results[0].deliveryId } })).toMatchObject({ status: "SENT", providerId: "wamid.T1", templateVersion: 1 });
      // Meta refuses another one for good → the desk gets the manual task (v4 WA-53), with the template details (MT-6).
      setWhatsAppFetchForTests((async () => new Response(JSON.stringify({ error: { code: 132001, message: "Template name does not exist" } }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch);
      const f = await sendMessage(D, { templateId: (await tpl("membership_expiring")).id, context: "MEMBER", recordId: a.memberId, channels: ["WHATSAPP"], autoWhatsApp: true });
      await settleAfterCommit();
      expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: f.results[0].deliveryId } })).toMatchObject({ status: "FAILED" });
      const task = await prisma.notificationDelivery.findFirstOrThrow({ where: { sendId: null, channel: "WHATSAPP_MANUAL", dedupeKey: `msg:${f.sendId}` } });
      expect(task).toMatchObject({ status: "QUEUED", templateId: null });
      await processMessageQueue({ sleep: async (ms) => clock.advance(ms) });
      expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ templateId: (await tpl("membership_expiring")).id, templateVersion: 1, sendId: f.sendId, recipientKey: `member:${a.memberId}` });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("v5 §3.4 bulk sends", () => {
  it("MT-11: bulk preview — the first 3 recipients rendered, per-channel counts; 'all matching the filter' resolves the list's filter (max 500)", async () => {
    const people = [];
    for (const name of ["Asha Kapoor", "Bina Rao", "Chetan Iyer", "Dev Sen"]) people.push(await person(name, { devices: 1 }));
    const gold = await person("Gita Gold", { plan: "GOLD" });
    const M = w.actors.MANAGER;
    const social = await tpl("friday_social");
    const p = await previewBulkSend(M, { templateId: social.id, list: "members", filter: "tier=SILVER&sort=name", channels: ["WHATSAPP", "EMAIL", "PUSH"] });
    expect(p.total).toBe(4);
    expect(p.perChannel).toEqual({ WHATSAPP: 4, EMAIL: 4, PUSH: 4 });
    expect(p.sample.map((s) => s.recipient.name)).toEqual(["Asha Kapoor", "Bina Rao", "Chetan Iyer"]);
    expect(p.sample[0].rendered.whatsapp!.text).toMatch(/^Hello from The Champions Club!/);
    expect(p.sample[0].rendered.email!.html).toContain(`/unsubscribe/UN1.m.${people[0].memberId}.`);
    expect(p.skipped).toEqual([]);
    expect(p.duplicates).toEqual([]);
    // Selected ids; a template for another kind of record; more than 500.
    expect((await previewBulkSend(M, { templateId: social.id, list: "members", ids: [gold.memberId], channels: ["WHATSAPP"] })).total).toBe(1);
    await expect(previewBulkSend(M, { templateId: (await tpl("trial_follow_up")).id, list: "members", ids: [gold.memberId], channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(previewBulkSend(M, { templateId: social.id, list: "members", ids: Array.from({ length: 501 }, (_, i) => `m${i}`), channels: ["WHATSAPP"] })).rejects.toThrow(/500/);
    await expect(previewBulkSend(M, { templateId: social.id, list: "members", filter: "tier=NOPE", channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Leads Board: lead templates.
    const lead = await createLead(w.actors.FRONT_DESK, { name: "Kiran Mehta", phone: "9811000077", source: "TRIAL_BOOKING" });
    const lp = await previewBulkSend(w.actors.FRONT_DESK, { templateId: (await tpl("trial_follow_up")).id, list: "leads", filter: "status=NEW", channels: ["WHATSAPP"] });
    expect(lp).toMatchObject({ total: 1, sample: [{ recipient: { kind: "LEAD", id: lead.id } }] });
  });

  it("MT-12: announcements skip anyone who opted out (email unsubscribe, WhatsApp STOP, no push device) and list them; transactional still respects the WhatsApp opt-out", async () => {
    const a = await person("Asha Kapoor", { devices: 1 });
    const b = await person("Bina Rao");
    const c = await person("Chetan Iyer", { devices: 1 });
    const d = await person("Dev Sen", { email: false });
    await prisma.member.update({ where: { id: b.memberId }, data: { emailAnnouncementsOptOut: true, emailAnnouncementsOptOutAt: clock.now() } });
    for (const x of [c, d]) await prisma.member.update({ where: { id: x.memberId }, data: { whatsappOptOutAt: clock.now() } });
    const M = w.actors.MANAGER;
    const r = await createBulkSend(M, { templateId: (await tpl("friday_social")).id, list: "members", ids: [a.memberId, b.memberId, c.memberId, d.memberId], channels: ["WHATSAPP", "EMAIL", "PUSH"] });
    expect(r.total).toBe(3);
    expect(r.skipped).toEqual([
      { name: "Bina Rao", reason: "Unsubscribed from announcement emails", channel: "EMAIL" },
      { name: "Bina Rao", reason: "No device has turned on notifications", channel: "PUSH" },
      { name: "Chetan Iyer", reason: "Opted out of WhatsApp (replied STOP)", channel: "WHATSAPP" },
      { name: "Dev Sen", reason: "Opted out of WhatsApp (replied STOP); No email address; No device has turned on notifications" },
    ]);
    const rows = await prisma.notificationDelivery.findMany({ where: { bulkId: r.bulkId } });
    const by = (id: string) => rows.filter((x) => x.memberId === id).map((x) => x.channel).sort();
    expect(by(a.memberId)).toEqual(["EMAIL", "PUSH", "WHATSAPP_MANUAL"]);
    expect(by(b.memberId)).toEqual(["WHATSAPP_MANUAL"]);
    expect(by(c.memberId)).toEqual(["EMAIL", "PUSH"]);
    expect(by(d.memberId)).toEqual([]);
    expect((await bulkProgress(M, r.bulkId)).skipped).toHaveLength(4);
    // Transactional from Renewal & Dues: the unsubscribe doesn't apply, the WhatsApp opt-out does.
    const t = await createBulkSend(w.actors.FRONT_DESK, { templateId: (await tpl("dues_reminder")).id, list: "renewals", ids: [b.memberId, c.memberId], channels: ["WHATSAPP", "EMAIL"] });
    expect(t.skipped).toEqual([{ name: "Chetan Iyer", reason: "Opted out of WhatsApp (replied STOP)", channel: "WHATSAPP" }]);
    const trows = await prisma.notificationDelivery.findMany({ where: { bulkId: t.bulkId } });
    expect(trows.filter((x) => x.memberId === b.memberId).map((x) => x.channel).sort()).toEqual(["EMAIL", "WHATSAPP_MANUAL"]);
    expect(await prisma.auditLog.count({ where: { action: "message.bulk_send" } })).toBe(2);
  });

  it("MT-13: email and push are sent by the worker at ≤ 1 message per second (injectable clock), with progress and a summary", async () => {
    const people = [];
    for (const name of ["Asha Kapoor", "Bina Rao", "Chetan Iyer"]) people.push(await person(name));
    await subscribePush(people[0].actor, { endpoint: "https://push.example.net/sub/rate", keys: KEYS, userAgent: ANDROID });
    const M = w.actors.MANAGER;
    const r = await createBulkSend(M, { templateId: (await tpl("membership_expiring")).id, list: "members", ids: people.map((p) => p.memberId), channels: ["EMAIL", "PUSH"] });
    expect(r).toMatchObject({ total: 3, skipped: [{ name: "Bina Rao", channel: "PUSH" }, { name: "Chetan Iyer", channel: "PUSH" }] });
    let p = await bulkProgress(M, r.bulkId);
    expect(p).toMatchObject({ status: "QUEUED", total: 3, queued: { total: 4, queued: 4, sent: 0 }, etaSeconds: 4, manual: { total: 0, nextId: null } });
    // The v4 push/email worker leaves these alone (they need the club layout); it only sends its own (welcome emails).
    await flushDeliveries();
    expect(mails.every((m) => !m.html)).toBe(true);
    expect(await prisma.notificationDelivery.count({ where: { bulkId: r.bulkId, status: "QUEUED", handledBy: "msgq:queue" } })).toBe(4);
    mails.length = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms);
    };
    expect(await processMessageQueue({ sleep, maxMessages: 2 })).toEqual({ sent: 2, failed: 0 });
    p = await bulkProgress(M, r.bulkId);
    expect(p).toMatchObject({ status: "SENDING", queued: { queued: 2, sent: 2 }, etaSeconds: 2 });
    expect(await processMessageQueue({ sleep })).toEqual({ sent: 2, failed: 0 });
    const sent = await prisma.notificationDelivery.findMany({ where: { bulkId: r.bulkId }, orderBy: { sentAt: "asc" } });
    const times = sent.map((x) => x.sentAt!.getTime());
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1000);
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(sleeps.every((ms) => ms > 0 && ms <= 1000)).toBe(true);
    expect(mails.map((m) => m.to).sort()).toEqual(people.map((x) => x.member.email).sort());
    expect(pushes).toHaveLength(1);
    p = await bulkProgress(M, r.bulkId);
    expect(p).toMatchObject({ status: "DONE", queued: { total: 4, queued: 0, sent: 4, failed: 0 }, finishedAt: expect.any(String), etaSeconds: 0 });
    expect(await processMessageQueue({ sleep })).toEqual({ sent: 0, failed: 0 });
    expect((await listBulkSends(M))[0]).toMatchObject({ id: r.bulkId, status: "DONE", total: 3 });
    // A run's budget is respected: nothing starts once it is used up.
    const r2 = await createBulkSend(M, { templateId: (await tpl("dues_reminder")).id, list: "members", ids: [people[0].memberId], channels: ["EMAIL"] });
    expect(await processMessageQueue({ sleep, budgetMs: 0 })).toEqual({ sent: 0, failed: 0 });
    expect((await bulkProgress(M, r2.bulkId)).status).toBe("QUEUED");
  });

  it("MT-14: WhatsApp by hand — one task per recipient in Messages to Send, stepped through with Send next; duplicates need confirmation", async () => {
    const people = [];
    for (const name of ["Asha Kapoor", "Bina Rao", "Chetan Iyer"]) people.push(await person(name));
    const D = w.actors.FRONT_DESK;
    // v6 SA-1: a "Dues reminder" to members who owe nothing is no longer opened ("no longer needed") — this test steps
    // through the queue, so it uses a template that is still relevant for these members.
    const t = await tpl("membership_expiring");
    const r = await createBulkSend(D, { templateId: t.id, list: "renewals", ids: people.map((p) => p.memberId), channels: ["WHATSAPP"] });
    expect(r.total).toBe(3);
    let p = await bulkProgress(D, r.bulkId);
    expect(p).toMatchObject({ status: "DONE", queued: { total: 0 }, manual: { total: 3, toSend: 3, opened: 0, sent: 0, nextId: expect.any(String) } });
    const queue = await listView(D, "notifications", { channel: "WHATSAPP_MANUAL", status: "QUEUED,LINK_OPENED", type: "TEMPLATE_MESSAGE" });
    expect(queue.total).toBe(3);
    expect(queue.rows.every((x) => x.template_name === t.name && x.bulk_id === r.bulkId)).toBe(true);
    const seen: string[] = [];
    while (p.manual.nextId) {
      const id = p.manual.nextId;
      seen.push(id);
      const { url } = await openManualMessage(D, id);
      expect(url).toMatch(/^https:\/\/wa\.me\/917\d{9}\?text=Hi%20/);
      expect((await bulkProgress(D, r.bulkId)).manual).toMatchObject({ opened: 1, nextId: id }); // still the one being sent
      await markManualSent(D, id);
      p = await bulkProgress(D, r.bulkId);
    }
    expect(new Set(seen).size).toBe(3);
    expect(p.manual).toEqual({ total: 3, toSend: 0, opened: 0, sent: 3, nextId: null });
    // Again within 24 h: confirmation needed, listing who already got it.
    const e = await err(createBulkSend(D, { templateId: t.id, list: "renewals", ids: people.map((x) => x.memberId), channels: ["WHATSAPP"] }));
    expect(e).toMatchObject({ code: "DUPLICATE_RECENT_SEND" });
    expect((e!.details!.recipients as unknown[]).length).toBe(3);
    expect((await previewBulkSend(D, { templateId: t.id, list: "renewals", ids: people.map((x) => x.memberId), channels: ["WHATSAPP"] })).duplicates).toHaveLength(3);
    expect((await createBulkSend(D, { templateId: t.id, list: "renewals", ids: people.map((x) => x.memberId), channels: ["WHATSAPP"], confirmDuplicate: true })).total).toBe(3);
  });

  it("MT-11: Check-in Risk — everyone with a problem in the view (filter), or the selected members", async () => {
    const m = await person("Asha Kapoor");
    await book(w, { time: "11:00", players: [{ memberId: m.memberId }] });
    await openTab(w.actors.BAR_STAFF, { memberId: m.memberId }); // OPEN_TAB problem, about this member
    const D = w.actors.FRONT_DESK;
    const t = await tpl("dues_reminder");
    const p = await previewBulkSend(D, { templateId: t.id, list: "checkin-risk", filter: "scope=soon", channels: ["WHATSAPP"] });
    expect(p.sample.map((s) => s.recipient.id)).toEqual([m.memberId]);
    expect((await previewBulkSend(D, { templateId: t.id, list: "checkin-risk", filter: "scope=today&kind=OPEN_TAB", channels: ["WHATSAPP"] })).total).toBe(1);
    await expect(previewBulkSend(D, { templateId: t.id, list: "checkin-risk", filter: "scope=today&kind=DUES", channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(previewBulkSend(D, { templateId: t.id, list: "checkin-risk", filter: "kind=NOPE", channels: ["WHATSAPP"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await createBulkSend(D, { templateId: t.id, list: "checkin-risk", ids: [m.memberId], channels: ["WHATSAPP"] })).total).toBe(1);
  });
});
