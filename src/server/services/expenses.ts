// Expenses and payables (plan §5.14 EX-1, EX-2; R-39). Paying an expense writes an OUT ledger entry (EXPENSE).
import type { ExpenseCategory, PaymentMethod } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { formatINR } from "@/lib/money";
import { addDays, dbDate, fromDbDate, istDate, isValidDateStr } from "@/lib/time";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { writeLedger } from "./ledger";

export const expenseSchema = z.object({
  vendor: z.string().trim().min(2).max(120),
  category: z.enum(["STOCK_PURCHASE", "UTILITIES", "RENT", "MAINTENANCE", "MARKETING", "OTHER"]),
  description: z.string().max(300).default(""),
  amount: z.number().int().positive(),
  inputGst: z.number().int().min(0).default(0),
  billDate: z.string().refine(isValidDateStr).optional(),
  dueDate: z.string().refine(isValidDateStr).optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
  refType: z.string().optional(),
  refId: z.string().optional(),
  attachmentUrl: z.string().regex(/^\/api\/uploads\/expense\/[a-z0-9]{24}\.(png|jpg|webp|pdf)$/, "Upload the bill first.").optional(),
});

/** Internal: used by goods receipts (SH-9) as well as the finance screen. */
export async function createExpenseTx(tx: Tx, actor: Actor, raw: z.input<typeof expenseSchema>) {
  const input = expenseSchema.parse(raw);
  const today = istDate(clock.now());
  const billDate = input.billDate ?? today;
  const dueDate = input.dueDate ?? addDays(billDate, input.dueInDays ?? 15);
  if (dueDate < billDate) throw new DomainError("VALIDATION_FAILED", "The due date can't be before the bill date.");
  const e = await tx.expenseBill.create({
    data: {
      vendor: input.vendor, category: input.category as ExpenseCategory, description: input.description, amount: input.amount,
      inputGst: input.inputGst, billDate: dbDate(billDate), dueDate: dbDate(dueDate), refType: input.refType ?? null, refId: input.refId ?? null,
      attachmentUrl: input.attachmentUrl ?? null,
      createdBy: actorId(actor),
    },
  });
  await audit(tx, actor, "expense.create", "expense_bill", e.id, { after: { vendor: e.vendor, amount: e.amount, category: e.category, dueDate } });
  return e;
}

export async function createExpense(actor: Actor, raw: z.input<typeof expenseSchema>, outer?: Tx) {
  assertCan(actor, "expenses.manage");
  return withTx((tx) => createExpenseTx(tx, actor, raw), outer);
}

/** Completion pass §7 (accountant): attach (or replace) the scanned bill of an expense. */
export async function setExpenseAttachment(actor: Actor, expenseId: string, url: string) {
  assertCan(actor, "expenses.manage");
  const parsed = expenseSchema.shape.attachmentUrl.parse(url);
  const e = await prisma.expenseBill.findUnique({ where: { id: expenseId } });
  if (!e) throw new DomainError("NOT_FOUND", "Expense bill was not found.");
  const updated = await prisma.expenseBill.update({ where: { id: e.id }, data: { attachmentUrl: parsed ?? null } });
  await audit(prisma, actor, "expense.attach", "expense_bill", e.id, { before: { attachmentUrl: e.attachmentUrl }, after: { attachmentUrl: parsed } });
  return updated;
}

export const payExpenseSchema = z.object({ method: z.enum(["CASH", "CARD", "UPI", "BANK_TRANSFER"]), reference: z.string().max(100).optional() });

/** EX-1: UNPAID → PAID with an OUT ledger entry (EXPENSE), in one transaction. */
export async function payExpense(actor: Actor, expenseId: string, raw: z.infer<typeof payExpenseSchema>, outer?: Tx) {
  assertCan(actor, "expenses.manage");
  const input = payExpenseSchema.parse(raw);
  return withTx(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM expense_bills WHERE id = ${expenseId} FOR UPDATE`;
    if (!locked.length) throw new DomainError("NOT_FOUND", "Expense bill was not found.");
    const e = await tx.expenseBill.findUniqueOrThrow({ where: { id: expenseId } });
    if (e.status !== "UNPAID") throw new DomainError("ORDER_STATE_INVALID", `This expense is already ${e.status.toLowerCase()}.`);
    const now = clock.now();
    const updated = await tx.expenseBill.update({ where: { id: e.id }, data: { status: "PAID", paidAt: now, method: input.method as PaymentMethod } });
    await writeLedger(tx, {
      source: "EXPENSE", direction: "OUT", method: input.method as PaymentMethod, amount: -e.amount, taxAmount: -e.inputGst,
      refType: "expense_bill", refId: e.id, description: `${e.category.replace("_", " ").toLowerCase()} · ${e.vendor}${input.reference ? ` · ${input.reference}` : ""}`,
      occurredAt: now,
    });
    await audit(tx, actor, "expense.pay", "expense_bill", e.id, { before: { status: "UNPAID" }, after: { status: "PAID", method: input.method, amount: e.amount } });
    return updated;
  }, outer);
}

export async function cancelExpense(actor: Actor, expenseId: string, reason: string) {
  assertCan(actor, "expenses.manage");
  if (reason.trim().length < 3) throw new DomainError("VALIDATION_FAILED", "A reason is required.");
  return withTx(async (tx) => {
    const e = await tx.expenseBill.findUnique({ where: { id: expenseId } });
    if (!e) throw new DomainError("NOT_FOUND", "Expense bill was not found.");
    if (e.status !== "UNPAID") throw new DomainError("ORDER_STATE_INVALID", `Only unpaid expenses can be cancelled (this one is ${e.status.toLowerCase()}).`);
    const updated = await tx.expenseBill.update({ where: { id: e.id }, data: { status: "CANCELLED" } });
    await audit(tx, actor, "expense.cancel", "expense_bill", e.id, { before: { status: "UNPAID" }, after: { status: "CANCELLED" }, reason });
    return updated;
  });
}

export async function listExpenses(actor: Actor, q: { status?: string; category?: string } = {}) {
  assertCan(actor, "expenses.view");
  const today = istDate(clock.now());
  const rows = await prisma.expenseBill.findMany({
    where: {
      status: q.status && q.status !== "OVERDUE" ? (q.status as "UNPAID" | "PAID" | "CANCELLED") : undefined,
      category: q.category ? (q.category as ExpenseCategory) : undefined,
    },
    orderBy: [{ billDate: "desc" }],
    take: 500,
  });
  const out = rows.map((e) => ({
    ...e, billDate: fromDbDate(e.billDate), dueDate: fromDbDate(e.dueDate),
    overdue: e.status === "UNPAID" && fromDbDate(e.dueDate) < today,
  }));
  return q.status === "OVERDUE" ? out.filter((e) => e.overdue) : out;
}

export function expenseLabel(e: { vendor: string; amount: number }) {
  return `${e.vendor} · ${formatINR(e.amount)}`;
}
