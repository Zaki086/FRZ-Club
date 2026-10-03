// v3 §6.5 NT-2: a member's bill left unpaid for `dues_reminder_days` gets a reminder on every available channel,
// then one a week later, at most three, and none once it is paid. A member's invoice with a due date is also reminded
// before it is due, on the day, and once when it is overdue (runInvoiceDueReminders).
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { addDays, dbDate, diffDays, fmtDate, fromDbDate, istDate } from "@/lib/time";
import { prisma, withTx } from "../db";
import { SYSTEM } from "../rbac/actor";
import { BILL_PORTAL_LINK, BILL_WHAT as WHAT, billDue } from "./bills";
import { memberAudience, notifyMember } from "./channels";
import { getSettings } from "./settings";

const DAY = 86_400_000;
/** Days before an invoice's due date that the "coming up" reminder goes out. */
export const INVOICE_DUE_SOON_DAYS = 3;

export async function runDuesReminders() {
  const s = await getSettings();
  const now = clock.now();
  const bills = await prisma.bill.findMany({
    where: { memberId: { not: null }, closedAt: null, status: { in: ["UNPAID", "PARTIAL"] }, createdAt: { lte: new Date(now.getTime() - s.dues_reminder_days * DAY) } },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  let sent = 0;
  for (const bill of bills) {
    const due = billDue(bill);
    if (due <= 0) continue;
    // An invoice with a due date still ahead is not overdue yet: runInvoiceDueReminders handles it until then.
    if (bill.sourceType === "INVOICE") {
      const inv = await prisma.invoice.findUnique({ where: { billId: bill.id }, select: { dueDate: true } });
      if (inv?.dueDate && fromDbDate(inv.dueDate) >= istDate(now)) continue;
    }
    const previous = await prisma.duesReminder.findMany({ where: { billId: bill.id }, orderBy: { seq: "desc" }, take: 1 });
    const seq = (previous[0]?.seq ?? 0) + 1;
    if (seq > 3) continue;
    if (previous[0] && now.getTime() - previous[0].sentAt.getTime() < 7 * DAY) continue;
    const member = await prisma.member.findUnique({ where: { id: bill.memberId! }, select: { id: true, userId: true, name: true } });
    if (!member?.userId) continue;
    const days = Math.floor((now.getTime() - bill.createdAt.getTime()) / DAY);
    const what = WHAT[bill.sourceType] ?? "bill";
    const ok = await withTx(async (tx) => {
      const ins = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO dues_reminders (id, bill_id, seq, sent_at, updated_at) VALUES (${`due_${bill.id}_${seq}`}, ${bill.id}, ${seq}, ${now}, now())
        ON CONFLICT (bill_id, seq) DO NOTHING RETURNING id`;
      if (!ins.length) return false;
      await notifyMember(tx, {
        event: "DUES_REMINDER", userId: member.userId!, memberId: member.id, actor: SYSTEM,
        title: `${formatINR(due)} due for your ${what}`,
        body: `Hi ${member.name.split(" ")[0]}, ${formatINR(due)} is still due for your ${what} (${days} days). Pay at the club${bill.sourceType === "MEMBERSHIP" ? " or online in the member portal" : ""}${seq < 3 ? "" : " — this is the last reminder"}.`,
        link: bill.sourceType === "MEMBERSHIP" || bill.sourceType === "INVOICE" ? BILL_PORTAL_LINK[bill.sourceType] : "/portal", dedupeKey: `dues:${bill.id}:${seq}`,
        params: [member.name, formatINR(due), what, String(days)],
        wa: { template: "dues_reminder", vars: { name: member.name.split(" ")[0], amount: formatINR(due).replace("₹", ""), whatFor: what } }, // v4 §4.1 optional template
      });
      return true;
    });
    if (ok) sent++;
  }
  return { sent };
}

/**
 * Daily: a member's issued invoice that is not fully paid is reminded INVOICE_DUE_SOON_DAYS before its due date, on the
 * due date, and once when it is overdue (later ones come from runDuesReminders). Each step exactly once, on every
 * channel the member (or a Junior's guardian) can receive. Overdue ones older than 30 days are left to the desk.
 */
export async function runInvoiceDueReminders() {
  const today = istDate(clock.now());
  const invoices = await prisma.invoice.findMany({
    where: { memberId: { not: null }, kind: { not: "MEMBERSHIP" }, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { gte: dbDate(addDays(today, -30)), lte: dbDate(addDays(today, INVOICE_DUE_SOON_DAYS)) } },
    orderBy: { dueDate: "asc" }, take: 500,
  });
  let sent = 0;
  for (const inv of invoices) {
    const bill = await prisma.bill.findUnique({ where: { id: inv.billId } });
    const due = bill && !bill.closedAt ? billDue(bill) : 0;
    if (due <= 0) continue;
    const dueOn = fromDbDate(inv.dueDate!);
    const left = diffDays(today, dueOn);
    const step = left > 0 ? "SOON" : left === 0 ? "TODAY" : "OVERDUE";
    const member = await prisma.member.findUnique({ where: { id: inv.memberId! }, select: { id: true, name: true } });
    if (!member) continue;
    const label = `invoice ${inv.number ?? ""}`.trim();
    const title = step === "SOON" ? `${formatINR(due)} due on ${fmtDate(dueOn)}: ${label}` : step === "TODAY" ? `${formatINR(due)} due today: ${label}` : `Overdue: ${formatINR(due)} for ${label}`;
    const body = step === "SOON"
      ? `Hi ${member.name.split(" ")[0]}, your ${label} has ${formatINR(due)} to pay by ${fmtDate(dueOn)} (in ${left} day${left === 1 ? "" : "s"}). Pay at the club; the invoice is in the member portal.`
      : step === "TODAY"
        ? `Hi ${member.name.split(" ")[0]}, ${formatINR(due)} on your ${label} is due today (${fmtDate(dueOn)}). Pay at the club; the invoice is in the member portal.`
        : `Hi ${member.name.split(" ")[0]}, ${formatINR(due)} on your ${label} was due on ${fmtDate(dueOn)} and is still unpaid. Please pay at the club.`;
    const days = String(Math.max(0, diffDays(inv.issueDate ? fromDbDate(inv.issueDate) : today, today)));
    const n = await withTx(async (tx) => {
      let made = 0;
      const audience = await memberAudience(tx, [member.id]);
      for (const [i, a] of audience.entries()) {
        const r = await notifyMember(tx, {
          event: "DUES_REMINDER", userId: a.userId, memberId: member.id, actor: SYSTEM, title, body, link: "/portal/invoices",
          dedupeKey: `invoice-due:${inv.id}:${step}${i ? `:${a.userId}` : ""}`, params: [member.name, formatINR(due), label, days],
          wa: { template: "dues_reminder", vars: { name: member.name.split(" ")[0], amount: formatINR(due).replace("₹", ""), whatFor: label } }, // v4 §4.1 optional template
        });
        if (r.length) made++;
      }
      return made;
    });
    if (n) sent++;
  }
  return { sent };
}
