// Communication (completion pass §3). Every message the club sends is logged (append-only message_log):
// emails when they are delivered or fail, WhatsApp messages when staff open the prepared wa.me link (status OPENED —
// the app can't know whether the staff member pressed send in WhatsApp, so it never claims "sent").
import { z } from "zod";
import { email as emailField, mobilePhone, optionalContact } from "@/lib/validation/contact";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { fmtDate, fmtDateTime, istDate } from "@/lib/time";
import { prisma, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { billDue } from "./bills";
import { effectiveStatus } from "./membership";
import { getSettings, updateSetting } from "./settings";
import { invalidateCapabilities, smtpConfigured } from "./capabilities";
import { mailTransport } from "./notifications";

export type MessageChannel = "EMAIL" | "WHATSAPP";
export type MessageStatus = "SENT" | "FAILED" | "OPENED";

export async function logMessage(
  db: Tx | typeof prisma,
  m: { channel: MessageChannel; to: string; subject?: string; body: string; status: MessageStatus; error?: string | null; entity?: string | null; entityId?: string | null; actorId?: string | null },
) {
  return db.messageLog.create({
    data: { channel: m.channel, to: m.to, subject: m.subject ?? "", body: m.body.slice(0, 4000), status: m.status, error: m.error ?? null, entity: m.entity ?? null, entityId: m.entityId ?? null, actorId: m.actorId ?? null, at: clock.now() },
  });
}

/** Indian mobile → wa.me number (91 + 10 digits). */
export function waNumber(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
}

export const whatsappSchema = z.discriminatedUnion("template", [
  z.object({ template: z.literal("BOOKING"), bookingId: z.string().min(1) }),
  z.object({ template: z.literal("MEMBERSHIP"), memberId: z.string().min(1) }),
  z.object({ template: z.literal("ORDER"), orderId: z.string().min(1) }),
  z.object({ template: z.literal("INVOICE"), invoiceId: z.string().min(1) }),
  z.object({ template: z.literal("LEAD"), leadId: z.string().min(1) }),
  z.object({ template: z.literal("CUSTOM"), phone: mobilePhone, text: z.string().trim().min(2).max(1000) }), // v5 CV-1
]);

const appUrl = () => (process.env.APP_URL ?? "").replace(/\/$/, "");

/** Build the message text and the recipient from the record (staff never type amounts or dates by hand). */
async function compose(input: z.infer<typeof whatsappSchema>): Promise<{ phone: string | null; text: string; entity: string; entityId: string | null }> {
  const s = await getSettings();
  const club = s.club.name || "the club";
  switch (input.template) {
    case "BOOKING": {
      const b = await prisma.booking.findUnique({ where: { id: input.bookingId }, include: { reservation: { include: { court: true } } } });
      if (!b) throw new DomainError("NOT_FOUND", "Booking was not found.");
      const person = b.primaryMemberId ? await prisma.member.findUnique({ where: { id: b.primaryMemberId } }) : b.primaryGuestId ? await prisma.guest.findUnique({ where: { id: b.primaryGuestId } }) : null;
      const bill = b.billId ? await prisma.bill.findUnique({ where: { id: b.billId } }) : null;
      const due = bill ? billDue(bill) : 0;
      const when = fmtDateTime(b.reservation.startAt);
      const text =
        b.status === "CANCELLED" || b.status === "CANCELLED_BY_CLUB"
          ? `Hi ${person?.name ?? ""}, your booking ${b.bookingCode} (${b.reservation.court.name}, ${when}) has been cancelled. — ${club}`
          : `Hi ${person?.name ?? ""}, your court booking ${b.bookingCode} is confirmed: ${b.reservation.court.name}, ${when}.${due > 0 ? ` ${formatINR(due)} is due at the front desk before check-in.` : ""} — ${club}`;
      return { phone: person?.phone ?? null, text, entity: "booking", entityId: b.id };
    }
    case "MEMBERSHIP": {
      const m = await prisma.member.findUnique({ where: { id: input.memberId } });
      if (!m) throw new DomainError("NOT_FOUND", "Member was not found.");
      const st = await effectiveStatus(m.id);
      const portal = appUrl() ? ` Renew at the desk or online: ${appUrl()}/portal/membership` : " Renew at the front desk.";
      const text =
        st.status === "ACTIVE" && st.endDate
          ? `Hi ${m.name}, your ${st.tier.toLowerCase()} membership is valid until ${fmtDate(st.endDate)} (${st.daysLeft} day${st.daysLeft === 1 ? "" : "s"} left).${portal} — ${club}`
          : st.status === "EXPIRED" && st.endDate
            ? `Hi ${m.name}, your membership ended on ${fmtDate(st.endDate)}.${portal} — ${club}`
            : `Hi ${m.name}, you don't have an active membership with ${club} at the moment.${portal}`;
      return { phone: m.phone, text, entity: "member", entityId: m.id };
    }
    case "ORDER": {
      const o = await prisma.shopOrder.findUnique({ where: { id: input.orderId } });
      if (!o) throw new DomainError("NOT_FOUND", "Order was not found.");
      const person = o.memberId ? await prisma.member.findUnique({ where: { id: o.memberId } }) : o.guestId ? await prisma.guest.findUnique({ where: { id: o.guestId } }) : null;
      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: o.billId } });
      const due = billDue(bill);
      const status = o.status.replace(/_/g, " ").toLowerCase();
      const track = appUrl() ? ` Track it: ${appUrl()}/orders/${o.trackToken}` : "";
      return { phone: person?.phone ?? null, text: `Hi ${person?.name ?? ""}, your order ${o.code} is ${status}.${due > 0 ? ` ${formatINR(due)} to pay.` : ""}${track} — ${club}`, entity: "shop_order", entityId: o.id };
    }
    case "INVOICE": {
      const inv = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
      if (!inv || !inv.number) throw new DomainError("NOT_FOUND", "Issued invoice was not found.");
      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: inv.billId } });
      const client = inv.businessClientId ? await prisma.businessClient.findUnique({ where: { id: inv.businessClientId } }) : null;
      const member = inv.memberId ? await prisma.member.findUnique({ where: { id: inv.memberId } }) : null;
      const due = billDue(bill);
      const name = client?.contactName ?? member?.name ?? "";
      const text = `Hi ${name}, invoice ${inv.number} from ${club}: total ${formatINR(bill.total)}${due > 0 ? `, balance ${formatINR(due)}${inv.dueDate ? ` due by ${fmtDate(istDate(inv.dueDate))}` : ""}` : ", fully paid — thank you"}.`;
      return { phone: client?.contactPhone ?? member?.phone ?? null, text, entity: "invoice", entityId: inv.id };
    }
    case "LEAD": {
      const l = await prisma.lead.findUnique({ where: { id: input.leadId } });
      if (!l) throw new DomainError("NOT_FOUND", "Lead was not found.");
      const q = await prisma.quote.findFirst({ where: { leadId: l.id, status: { in: ["SENT", "INTERESTED"] } }, orderBy: { createdAt: "desc" } });
      const text = q && appUrl()
        ? `Hi ${l.name}, here is your quote from ${club} (${formatINR(q.total)}): ${appUrl()}/quote/${q.token}`
        : `Hi ${l.name}, thank you for your interest in ${club}. When would be a good time to visit or talk?`;
      return { phone: l.phone, text, entity: "lead", entityId: l.id };
    }
    case "CUSTOM":
      return { phone: input.phone, text: input.text, entity: "custom", entityId: null };
  }
}

/** Prepare a WhatsApp message (wa.me link) and log it as OPENED. No WhatsApp API, nothing sent on the club's behalf. */
export async function whatsappLink(actor: Actor, raw: z.infer<typeof whatsappSchema>) {
  assertCan(actor, "messages.send");
  const input = whatsappSchema.parse(raw);
  const c = await compose(input);
  const number = c.phone ? waNumber(c.phone) : null;
  if (!number) throw new DomainError("VALIDATION_FAILED", "There is no valid Indian mobile number to message.");
  await logMessage(prisma, { channel: "WHATSAPP", to: number, body: c.text, status: "OPENED", entity: c.entity, entityId: c.entityId, actorId: actorId(actor) });
  return { url: `https://wa.me/${number}?text=${encodeURIComponent(c.text)}`, to: number, text: c.text };
}

export const testEmailSchema = z.object({ to: optionalContact(emailField) }); // v5 CV-4

/** Owner: send a real test email now; success marks email as verified (capability `email`). */
export async function sendTestEmail(actor: Actor, raw: z.infer<typeof testEmailSchema> = {}) {
  assertCan(actor, "settings");
  const input = testEmailSchema.parse(raw);
  if (!smtpConfigured() && process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    throw new DomainError("VALIDATION_FAILED", "Set SMTP_HOST and SMTP_FROM in the server's .env first, then restart the app.");
  }
  const me = actor.kind === "USER" ? await prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }) : null;
  const to = input.to ?? me?.email ?? "";
  if (!to) throw new DomainError("VALIDATION_FAILED", "Enter the address to send the test email to.");
  const s = await getSettings();
  const subject = `Test email from ${s.club.name || "the club"}`;
  const body = "This is a test email. If you can read it, email is working and the app will start using it.";
  try {
    await mailTransport().sendMail({ from: process.env.SMTP_FROM, to, subject, text: body });
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 500) : String(e);
    await logMessage(prisma, { channel: "EMAIL", to, subject, body, status: "FAILED", error, entity: "test", actorId: actorId(actor) });
    throw new DomainError("VALIDATION_FAILED", `The test email could not be sent: ${error}`);
  }
  await logMessage(prisma, { channel: "EMAIL", to, subject, body, status: "SENT", entity: "test", actorId: actorId(actor) });
  const at = clock.now().toISOString();
  await updateSetting(actor, "email_verified_at", at);
  await audit(prisma, actor, "email.verified", "setting", "email_verified_at", { after: { to, at } });
  invalidateCapabilities();
  return { to, verifiedAt: at };
}

export const messageQuerySchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP"]).optional(),
  status: z.enum(["SENT", "FAILED", "OPENED"]).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Owner: every message sent or prepared, newest first. */
export async function listMessages(actor: Actor, raw: z.input<typeof messageQuerySchema> = {}) {
  assertCan(actor, "messages.log");
  const input = messageQuerySchema.parse(raw);
  const rows = await prisma.messageLog.findMany({
    where: {
      channel: input.channel, status: input.status,
      OR: input.q ? [{ to: { contains: input.q, mode: "insensitive" } }, { subject: { contains: input.q, mode: "insensitive" } }, { body: { contains: input.q, mode: "insensitive" } }] : undefined,
    },
    orderBy: { at: "desc" },
    take: input.limit,
  });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return rows.map((r) => ({ ...r, actorName: users.find((u) => u.id === r.actorId)?.name ?? null }));
}
