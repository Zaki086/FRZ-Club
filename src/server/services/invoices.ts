// Invoices (plan §5.11 IN-1…IN-6, R-40, R-41, R-44, E-21). Numbering is a gap-free sequence per financial year.
import type { Bill, Invoice, Prisma } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatInvoiceNumber, isValidGstin } from "@/lib/codes";
import { contactPhone as contactPhoneField, email as emailField, optionalContact } from "@/lib/validation/contact";
import { formatINR } from "@/lib/money";
import { addDays, dbDate, financialYear, fromDbDate, istDate } from "@/lib/time";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { actorId } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { billDue, closeBill, createBill, refreshBill } from "./bills";
import { notify, queueEmail } from "./notifications";
import { quoteManual, quoteShop, type PricedLine } from "./pricing";
import { getSettings, type TaxCategory } from "./settings";
import { absoluteUrl } from "@/lib/url";

/** Next invoice number in the financial year of `issueDate` (atomic upsert = row lock on the FY counter). */
export async function nextInvoiceNumber(tx: Tx, issueDate: string): Promise<{ fy: string; seq: number; number: string }> {
  const fy = financialYear(issueDate);
  const rows = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO invoice_counters (fy, last, updated_at) VALUES (${fy}, 1, now())
    ON CONFLICT (fy) DO UPDATE SET last = invoice_counters.last + 1, updated_at = now()
    RETURNING last`;
  const seq = rows[0].last;
  return { fy, seq, number: formatInvoiceNumber(fy, seq) };
}

/** IN-4: a paid membership auto-issues a tax invoice to the member (B2C → intra-state, IN-3). */
export async function issueMembershipInvoice(tx: Tx, actor: Actor, bill: Bill, memberId: string): Promise<Invoice> {
  const existing = await tx.invoice.findUnique({ where: { billId: bill.id } });
  if (existing) return existing;
  const s = await getSettings(tx);
  const today = istDate(clock.now());
  const n = await nextInvoiceNumber(tx, today);
  const inv = await tx.invoice.create({
    data: {
      number: n.number, fy: n.fy, seq: n.seq, kind: "MEMBERSHIP", memberId,
      placeOfSupply: s.club.state_code, issueDate: dbDate(today), dueDate: dbDate(today),
      status: "PAID", billId: bill.id, createdBy: actorId(actor),
    },
  });
  await audit(tx, actor, "invoice.create", "invoice", inv.id, { after: { number: inv.number, kind: "MEMBERSHIP", billId: bill.id } });
  const member = await tx.member.findUnique({ where: { id: memberId }, select: { email: true, name: true } });
  if (member?.email) {
    await queueEmail(tx, {
      to: member.email,
      subject: `${s.gstEnabled ? "Tax invoice" : "Receipt"} ${inv.number} — ${s.club.name}`,
      body: `Dear ${member.name},\n\nThank you for your membership payment of ${formatINR(bill.total)}. Your ${s.gstEnabled ? "tax invoice" : "receipt"} ${inv.number} is available in the member portal: ${absoluteUrl("/portal/invoices")}`, // URL-1
      dedupeKey: `invoice-issued:${inv.id}`,
    });
  }
  return inv;
}

// ───────────── tax split (IN-3) ─────────────

export type TaxSplit = { cgst: number; sgst: number; igst: number };

/** Intra-state (club state) → CGST + SGST halves; inter-state → IGST. */
export function splitTax(taxAmount: number, placeOfSupply: string, clubState: string): TaxSplit {
  if (placeOfSupply !== clubState) return { cgst: 0, sgst: 0, igst: taxAmount };
  const cgst = Math.floor(taxAmount / 2);
  return { cgst, sgst: taxAmount - cgst, igst: 0 };
}

// ───────────── business clients (IN-1) ─────────────

export const clientSchema = z.object({
  name: z.string().trim().min(2).max(120),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .optional()
    .or(z.literal("").transform(() => undefined))
    .refine((g) => !g || isValidGstin(g), "GSTIN must be 15 characters: 2-digit state code, PAN, entity code, Z, checksum"),
  stateCode: z.string().regex(/^\d{2}$/).optional(),
  address: z.string().trim().min(5).max(300),
  contactName: z.string().trim().min(2).max(100),
  // v5 CV-3/CV-4: a business contact may give a mobile or an STD landline.
  contactEmail: optionalContact(emailField),
  contactPhone: optionalContact(contactPhoneField),
  paymentTermsDays: z.number().int().min(0).max(180).optional(),
});

export async function createClient(actor: Actor, raw: z.infer<typeof clientSchema>, outer?: Tx) {
  assertCan(actor, "invoices");
  const input = clientSchema.parse(raw);
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    // IN-1: first 2 digits of the GSTIN are the state code; without a GSTIN the client is treated as in-state.
    const stateCode = input.gstin ? input.gstin.slice(0, 2) : (input.stateCode ?? s.club.state_code);
    const c = await tx.businessClient.create({
      data: {
        name: input.name, gstin: input.gstin ?? null, stateCode, address: input.address,
        contactName: input.contactName, contactEmail: input.contactEmail ?? null, contactPhone: input.contactPhone ?? null,
        paymentTermsDays: input.paymentTermsDays ?? s.invoice_terms_days,
      },
    });
    await audit(tx, actor, "client.create", "business_client", c.id, { after: c });
    return c;
  }, outer);
}

export async function listClients(actor: Actor) {
  assertCan(actor, "invoices");
  const clients = await prisma.businessClient.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } });
  const bills = await prisma.bill.findMany({
    where: { businessClientId: { in: clients.map((c) => c.id) }, closedAt: null },
    select: { businessClientId: true, total: true, amountPaid: true, amountRefunded: true, closedAt: true },
  });
  return clients.map((c) => ({
    ...c,
    outstanding: bills.filter((b) => b.businessClientId === c.id).reduce((a, b) => a + billDue(b), 0),
  }));
}

// ───────────── invoices (IN-2) ─────────────

const lineSchema = z.object({
  kind: z.enum(["MANUAL", "CATALOGUE"]).default("MANUAL"),
  description: z.string().trim().min(2).max(200).optional(),
  qty: z.number().int().positive(),
  unitPrice: z.number().int().min(0).optional(),
  variantId: z.string().optional(),
  taxCategory: z.enum(["COURT", "MEMBERSHIP", "GOODS_5", "GOODS_18", "SERVICE", "RESTAURANT", "DELIVERY", "BUSINESS_SERVICE"]).optional(),
});

export const invoiceDraftSchema = z.object({
  businessClientId: z.string().optional(),
  memberId: z.string().optional(),
  lines: z.array(lineSchema).min(1).max(50),
  notes: z.string().max(500).optional(),
});

/** Create a DRAFT invoice with its bill. Lines are priced by the pricing engine (catalogue) or as entered (manual). */
export async function createDraft(actor: Actor, raw: z.infer<typeof invoiceDraftSchema>, outer?: Tx) {
  assertCan(actor, "invoices");
  const input = invoiceDraftSchema.parse(raw);
  if (!!input.businessClientId === !!input.memberId) {
    throw new DomainError("VALIDATION_FAILED", "Choose exactly one customer: a business client or a member.");
  }
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const today = istDate(clock.now());
    let name: string;
    let placeOfSupply = s.club.state_code;
    if (input.businessClientId) {
      const c = await tx.businessClient.findUnique({ where: { id: input.businessClientId } });
      if (!c) throw new DomainError("NOT_FOUND", "Business client was not found.");
      name = c.name;
      placeOfSupply = c.gstin ? c.stateCode : s.club.state_code; // IN-3: B2B uses the GSTIN state; B2C is intra-state
    } else {
      const m = await tx.member.findUnique({ where: { id: input.memberId! } });
      if (!m) throw new DomainError("NOT_FOUND", "Member was not found.");
      name = m.name;
    }
    const lines: PricedLine[] = [];
    for (const l of input.lines) {
      if (l.kind === "CATALOGUE") {
        if (!l.variantId) throw new DomainError("VALIDATION_FAILED", "Catalogue lines need a product.");
        const v = await tx.productVariant.findUnique({ where: { id: l.variantId }, include: { product: true } });
        if (!v) throw new DomainError("NOT_FOUND", "Product was not found.");
        const q = await quoteShop(tx, {
          memberId: input.memberId ?? null,
          date: today,
          items: [{ variantId: v.id, qty: l.qty, name: `${v.product.name} — ${v.label}`, price: v.price, taxCategory: v.taxCategory, hsnSac: v.hsnSac }],
        }, s);
        lines.push(...q.lines);
      } else {
        if (!l.description || l.unitPrice === undefined) throw new DomainError("VALIDATION_FAILED", "Manual lines need a description and a price.");
        lines.push(...quoteManual([{ description: l.description, qty: l.qty, unitPrice: l.unitPrice, taxCategory: (l.taxCategory ?? "BUSINESS_SERVICE") as TaxCategory }], s).lines);
      }
    }
    const bill = await createBill(tx, {
      sourceType: "INVOICE",
      customer: { businessClientId: input.businessClientId ?? null, memberId: input.memberId ?? null, name },
      tier: "WALK_IN",
      lines,
      createdBy: actorId(actor),
    });
    const inv = await tx.invoice.create({
      data: {
        kind: input.businessClientId ? "BUSINESS" : "MEMBER",
        businessClientId: input.businessClientId ?? null,
        memberId: input.memberId ?? null,
        placeOfSupply,
        status: "DRAFT",
        billId: bill.id,
        notes: input.notes ?? "",
        createdBy: actorId(actor),
      },
    });
    await tx.bill.update({ where: { id: bill.id }, data: { sourceId: inv.id } });
    await audit(tx, actor, "invoice.create", "invoice", inv.id, { after: { kind: inv.kind, total: bill.total } });
    return { invoice: inv, bill };
  }, outer);
}

/** DRAFT → ISSUED: assigns the FY number and due date (payment terms). */
export async function issueInvoice(actor: Actor, invoiceId: string, outer?: Tx) {
  assertCan(actor, "invoices");
  return withTx(async (tx) => {
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new DomainError("NOT_FOUND", "Invoice was not found.");
    if (inv.status !== "DRAFT") throw new DomainError("ORDER_STATE_INVALID", `Only draft invoices can be issued (this one is ${inv.status}).`);
    const s = await getSettings(tx);
    const today = istDate(clock.now());
    let terms = s.invoice_terms_days;
    let email: string | null = null;
    let name = "";
    if (inv.businessClientId) {
      const c = await tx.businessClient.findUniqueOrThrow({ where: { id: inv.businessClientId } });
      terms = c.paymentTermsDays;
      email = c.contactEmail;
      name = c.name;
    } else if (inv.memberId) {
      const m = await tx.member.findUniqueOrThrow({ where: { id: inv.memberId } });
      email = m.email;
      name = m.name;
    }
    const n = await nextInvoiceNumber(tx, today);
    const bill = await refreshBill(tx, inv.billId);
    const updated = await tx.invoice.update({
      where: { id: inv.id },
      data: {
        number: n.number, fy: n.fy, seq: n.seq, issueDate: dbDate(today), dueDate: dbDate(addDays(today, terms)),
        status: bill.status === "PAID" ? "PAID" : "ISSUED",
      },
    });
    await audit(tx, actor, "invoice.issue", "invoice", inv.id, { before: { status: "DRAFT" }, after: { status: updated.status, number: n.number } });
    if (email) {
      await queueEmail(tx, {
        to: email,
        subject: `Invoice ${n.number} from ${(await getSettings(tx)).club.name}`,
        body: `Dear ${name},\n\nPlease find invoice ${n.number} for ${formatINR(bill.total)}, due on ${addDays(today, terms)}.`,
        dedupeKey: `invoice-issued:${inv.id}`,
      });
    }
    await notify(tx, {
      roles: ["ACCOUNTANT"],
      type: "INVOICE_ISSUED",
      title: `Invoice ${n.number} issued`,
      body: `${name} · ${formatINR(bill.total)} · due ${addDays(today, terms)}`,
      link: `/app/finance/invoices/${inv.id}`,
      dedupeKey: `invoice-issued:${inv.id}`,
    });
    if (inv.memberId) {
      const m = await tx.member.findUnique({ where: { id: inv.memberId }, select: { userId: true } });
      if (m?.userId) {
        await notify(tx, {
          userIds: [m.userId], type: "INVOICE_ISSUED", title: `Invoice ${n.number}`,
          body: `${formatINR(bill.total)} due ${addDays(today, terms)}`, link: "/portal/invoices", dedupeKey: `invoice-issued:${inv.id}`,
        });
      }
    }
    return updated;
  }, outer);
}

/** Issued invoices are cancelled, never deleted. Paid money must be refunded first. */
export async function cancelInvoice(actor: Actor, invoiceId: string, reason: string) {
  assertCan(actor, "invoices");
  if (reason.trim().length < 3) throw new DomainError("VALIDATION_FAILED", "A reason is required to cancel an invoice.");
  return withTx(async (tx) => {
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new DomainError("NOT_FOUND", "Invoice was not found.");
    if (inv.kind === "MEMBERSHIP") throw new DomainError("ORDER_STATE_INVALID", "Membership invoices follow the membership; cancel the membership instead.");
    if (inv.status === "CANCELLED") throw new DomainError("ORDER_STATE_INVALID", "This invoice is already cancelled.");
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: inv.billId } });
    if (bill.amountPaid - bill.amountRefunded > 0) {
      throw new DomainError("ORDER_STATE_INVALID", `This invoice has ${formatINR(bill.amountPaid - bill.amountRefunded)} paid; refund it before cancelling.`);
    }
    await closeBill(tx, bill.id, `Invoice cancelled: ${reason}`, clock.now());
    const updated = await tx.invoice.update({ where: { id: inv.id }, data: { status: "CANCELLED", cancelReason: reason } });
    await audit(tx, actor, "invoice.cancel", "invoice", inv.id, { before: { status: inv.status }, after: { status: "CANCELLED" }, reason });
    return updated;
  });
}

/** Keep the invoice status in step with its bill (called when an INVOICE bill is paid). */
export async function onInvoiceBillPaid(tx: Tx, bill: Bill, actor: Actor) {
  const inv = await tx.invoice.findUnique({ where: { billId: bill.id } });
  if (!inv || inv.status === "CANCELLED" || inv.status === "DRAFT") return;
  if (inv.status !== "PAID") {
    await tx.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
    await audit(tx, actor, "invoice.paid", "invoice", inv.id, { before: { status: inv.status }, after: { status: "PAID" } });
  }
}

/** Partial payments move ISSUED → PARTIALLY_PAID. */
export async function syncInvoiceStatus(tx: Tx, billId: string) {
  const inv = await tx.invoice.findUnique({ where: { billId } });
  if (!inv || inv.kind === "MEMBERSHIP" || inv.status === "DRAFT" || inv.status === "CANCELLED") return;
  const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId } });
  const status = bill.status === "PAID" ? "PAID" : bill.amountPaid > 0 ? "PARTIALLY_PAID" : "ISSUED";
  if (status !== inv.status) await tx.invoice.update({ where: { id: inv.id }, data: { status } });
}

export function isOverdue(inv: Pick<Invoice, "status" | "dueDate">, today: string): boolean {
  return (inv.status === "ISSUED" || inv.status === "PARTIALLY_PAID") && !!inv.dueDate && fromDbDate(inv.dueDate) < today;
}

/** Daily job: notify about overdue invoices once each (dedupe). OVERDUE itself is derived, never stored. */
export async function markOverdueInvoices(outer?: Tx) {
  return withTx(async (tx) => {
    const today = istDate(clock.now());
    const due = await tx.invoice.findMany({
      where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { lt: dbDate(today) }, overdueNotifiedAt: null },
    });
    for (const inv of due) {
      const bill = await tx.bill.findUniqueOrThrow({ where: { id: inv.billId } });
      await tx.invoice.update({ where: { id: inv.id }, data: { overdueNotifiedAt: clock.now() } });
      await notify(tx, {
        roles: ["ACCOUNTANT", "OWNER"],
        type: "INVOICE_OVERDUE",
        title: `Invoice ${inv.number} is overdue`,
        body: `${bill.customerName} · ${formatINR(billDue(bill))} outstanding since ${fromDbDate(inv.dueDate!)}`,
        link: `/app/finance/invoices/${inv.id}`,
        dedupeKey: `invoice-overdue:${inv.id}`,
      });
      // A member with a login hears it from runInvoiceDueReminders on every channel (dues.ts); email only the others.
      const member = inv.memberId ? await tx.member.findUnique({ where: { id: inv.memberId } }) : null;
      const email = inv.businessClientId
        ? (await tx.businessClient.findUnique({ where: { id: inv.businessClientId } }))?.contactEmail
        : member && !member.userId
          ? member.email
          : null;
      if (email) {
        await queueEmail(tx, {
          to: email,
          subject: `Reminder: invoice ${inv.number} is overdue`,
          body: `Invoice ${inv.number} (${formatINR(billDue(bill))} outstanding) was due on ${fromDbDate(inv.dueDate!)}.`,
          dedupeKey: `invoice-overdue:${inv.id}`,
        });
      }
    }
    return due.length;
  }, outer);
}

export async function listInvoices(actor: Actor, q: { status?: string; clientId?: string; memberId?: string } = {}) {
  if (actor.kind === "USER" && actor.role === "MEMBER") {
    q = { memberId: actor.memberId ?? "-" };
  } else {
    assertCan(actor, "invoices");
  }
  const where: Prisma.InvoiceWhereInput = {
    businessClientId: q.clientId || undefined,
    memberId: q.memberId || undefined,
    status: q.status && q.status !== "OVERDUE" ? (q.status as Invoice["status"]) : undefined,
  };
  if (actor.kind === "USER" && actor.role === "MEMBER") where.status = { not: "DRAFT" };
  const invoices = await prisma.invoice.findMany({ where, orderBy: [{ createdAt: "desc" }], take: 500 });
  const bills = await prisma.bill.findMany({ where: { id: { in: invoices.map((i) => i.billId) } } });
  const clients = await prisma.businessClient.findMany({ where: { id: { in: invoices.map((i) => i.businessClientId).filter((x): x is string => !!x) } } });
  const today = istDate(clock.now());
  const rows = invoices.map((i) => {
    const b = bills.find((x) => x.id === i.billId)!;
    return {
      ...i,
      customer: i.businessClientId ? (clients.find((c) => c.id === i.businessClientId)?.name ?? "") : b.customerName,
      total: b.total,
      due: billDue(b),
      overdue: isOverdue(i, today),
    };
  });
  return q.status === "OVERDUE" ? rows.filter((r) => r.overdue) : rows;
}

/** IN-5: everything the printable invoice needs, including the CGST/SGST/IGST split per line. */
export async function getInvoice(actor: Actor, invoiceId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new DomainError("NOT_FOUND", "Invoice was not found.");
  if (actor.kind === "USER" && actor.role === "MEMBER") {
    if (inv.memberId !== actor.memberId || inv.status === "DRAFT") throw new DomainError("FORBIDDEN", "Not allowed: this invoice belongs to someone else.");
  } else {
    assertCan(actor, "invoices");
  }
  const s = await getSettings();
  const bill = await prisma.bill.findUniqueOrThrow({ where: { id: inv.billId }, include: { lines: { where: { voidedAt: null } }, payments: true } });
  const client = inv.businessClientId ? await prisma.businessClient.findUnique({ where: { id: inv.businessClientId } }) : null;
  const member = inv.memberId ? await prisma.member.findUnique({ where: { id: inv.memberId } }) : null;
  const lines = bill.lines.map((l) => ({ ...l, taxable: l.netAmount - l.taxAmount, ...splitTax(l.taxAmount, inv.placeOfSupply, s.club.state_code) }));
  const totals = lines.reduce(
    (a, l) => ({ taxable: a.taxable + l.taxable, cgst: a.cgst + l.cgst, sgst: a.sgst + l.sgst, igst: a.igst + l.igst, total: a.total + l.netAmount }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 },
  );
  return {
    invoice: inv,
    club: s.club,
    // §1 gst: without GST registration the document is a plain receipt with no tax lines.
    gst: s.gstEnabled,
    taxRatesVerified: (await prisma.setting.findUnique({ where: { key: "tax_rates" } }))?.verified ?? false,
    client,
    member,
    bill: { ...bill, due: billDue(bill) },
    lines,
    totals,
    overdue: isOverdue(inv, istDate(clock.now())),
  };
}
