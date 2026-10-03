// Payroll (plan §5.13 ST-6, ST-7; R-42). Visible only to OWNER and ACCOUNTANT. Paying writes PAYROLL OUT ledger entries.
import type { PaymentMethod } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { roundDiv } from "@/lib/money";
import { daysInMonth, dbDate, fromDbDate } from "@/lib/time";
import { pgErrorCode, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { writeLedger } from "./ledger";
import { notify } from "./notifications";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  const dim = daysInMonth(y, m);
  return { first: `${month}-01`, last: `${month}-${String(dim).padStart(2, "0")}`, dim };
}

/** Approved UNPAID leave days of an employee that fall inside the month. */
async function unpaidLeaveDays(tx: Tx, employeeId: string, month: string) {
  const { first, last } = monthBounds(month);
  const rows = await tx.leaveRequest.findMany({
    where: { employeeId, type: "UNPAID", status: "APPROVED", startDate: { lte: dbDate(last) }, endDate: { gte: dbDate(first) } },
  });
  let days = 0;
  for (const r of rows) {
    const s = fromDbDate(r.startDate) > first ? fromDbDate(r.startDate) : first;
    const e = fromDbDate(r.endDate) < last ? fromDbDate(r.endDate) : last;
    days += Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86_400_000) + 1;
  }
  return days;
}

/** ST-6: gross = monthly salary; deduction = unpaid leave days × (salary ÷ days in month); net = gross − deduction. */
export async function createPayrollRun(actor: Actor, rawMonth: string, outer?: Tx) {
  assertCan(actor, "payroll");
  const month = monthSchema.parse(rawMonth);
  return withTx(async (tx) => {
    const { last, dim } = monthBounds(month);
    let run;
    try {
      run = await tx.payrollRun.create({ data: { month, createdBy: actorId(actor) } });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new DomainError("VALIDATION_FAILED", `A payroll run for ${month} already exists.`);
      throw e;
    }
    const employees = await tx.employee.findMany({ where: { active: true, monthlySalary: { gt: 0 }, joinDate: { lte: dbDate(last) } }, include: { user: true } });
    for (const e of employees) {
      const unpaid = await unpaidLeaveDays(tx, e.id, month);
      const deductions = roundDiv(unpaid * e.monthlySalary, dim);
      await tx.payslip.create({ data: { runId: run.id, employeeId: e.id, gross: e.monthlySalary, unpaidDays: unpaid, deductions, net: e.monthlySalary - deductions } });
    }
    await audit(tx, actor, "payroll.create", "payroll_run", run.id, { after: { month, employees: employees.length } });
    return getRunTx(tx, run.id);
  }, outer);
}

/** DRAFT → APPROVED by the Owner. */
export async function approvePayrollRun(actor: Actor, runId: string, outer?: Tx) {
  assertCan(actor, "payroll");
  if (actor.kind === "USER" && actor.role !== "OWNER") throw new DomainError("FORBIDDEN", "Not allowed: only the owner approves payroll.");
  return withTx(async (tx) => {
    const run = await tx.payrollRun.findUnique({ where: { id: runId } });
    if (!run) throw new DomainError("NOT_FOUND", "Payroll run was not found.");
    if (run.status !== "DRAFT") throw new DomainError("ORDER_STATE_INVALID", `Payroll ${run.month} is already ${run.status.toLowerCase()}.`);
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED", approvedBy: actorId(actor), approvedAt: clock.now() } });
    await audit(tx, actor, "payroll.approve", "payroll_run", run.id, { before: { status: "DRAFT" }, after: { status: "APPROVED" } });
    await notify(tx, { roles: ["ACCOUNTANT"], type: "PAYROLL_APPROVED", title: `Payroll ${run.month} approved`, body: "Ready to pay.", link: `/app/finance/payroll/${run.id}`, dedupeKey: `payroll-approved:${run.id}` });
    return getRunTx(tx, run.id);
  }, outer);
}

export const payRunSchema = z.object({ method: z.enum(["CASH", "CARD", "UPI", "ONLINE"]).default("ONLINE") });

/** APPROVED → PAID: one PAYROLL OUT ledger entry per payslip, same transaction. */
export async function payPayrollRun(actor: Actor, runId: string, raw: z.input<typeof payRunSchema> = {}, outer?: Tx) {
  assertCan(actor, "payroll");
  const input = payRunSchema.parse(raw);
  return withTx(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payroll_runs WHERE id = ${runId} FOR UPDATE`;
    if (!locked.length) throw new DomainError("NOT_FOUND", "Payroll run was not found.");
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId }, include: { payslips: true } });
    if (run.status !== "APPROVED") throw new DomainError("ORDER_STATE_INVALID", run.status === "PAID" ? `Payroll ${run.month} is already paid.` : `Payroll ${run.month} must be approved by the owner first.`);
    const now = clock.now();
    const emps = await tx.employee.findMany({ where: { id: { in: run.payslips.map((p) => p.employeeId) } }, include: { user: true } });
    for (const p of run.payslips) {
      await tx.payslip.update({ where: { id: p.id }, data: { paidAt: now, method: input.method as PaymentMethod } });
      if (p.net > 0) {
        await writeLedger(tx, {
          source: "PAYROLL", direction: "OUT", method: input.method as PaymentMethod, amount: -p.net, refType: "payslip", refId: p.id,
          description: `salary ${run.month} · ${emps.find((e) => e.id === p.employeeId)?.user.name ?? ""}`, occurredAt: now,
        });
      }
    }
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "PAID", paidAt: now, method: input.method as PaymentMethod } });
    await audit(tx, actor, "payroll.pay", "payroll_run", run.id, { before: { status: "APPROVED" }, after: { status: "PAID", total: run.payslips.reduce((a, p) => a + p.net, 0) } });
    for (const e of emps) {
      await notify(tx, { userIds: [e.userId], type: "PAYSLIP", title: `Salary for ${run.month} paid`, body: "Your payslip is available from the accountant.", dedupeKey: `payslip:${run.id}:${e.id}` });
    }
    return getRunTx(tx, run.id);
  }, outer);
}

async function getRunTx(tx: Tx | typeof prisma, runId: string) {
  const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId }, include: { payslips: true } });
  const emps = await tx.employee.findMany({ where: { id: { in: run.payslips.map((p) => p.employeeId) } }, include: { user: true } });
  return {
    ...run,
    totals: run.payslips.reduce((a, p) => ({ gross: a.gross + p.gross, deductions: a.deductions + p.deductions, net: a.net + p.net }), { gross: 0, deductions: 0, net: 0 }),
    payslips: run.payslips.map((p) => {
      const e = emps.find((x) => x.id === p.employeeId)!;
      return { ...p, name: e.user.name, role: e.user.role };
    }),
  };
}

export async function getPayrollRun(actor: Actor, runId: string) {
  assertCan(actor, "payroll");
  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  if (!run) throw new DomainError("NOT_FOUND", "Payroll run was not found.");
  return getRunTx(prisma, runId);
}

export async function listPayrollRuns(actor: Actor) {
  assertCan(actor, "payroll");
  const runs = await prisma.payrollRun.findMany({ orderBy: { month: "desc" }, include: { payslips: true } });
  return runs.map((r) => ({ id: r.id, month: r.month, status: r.status, paidAt: r.paidAt, employees: r.payslips.length, net: r.payslips.reduce((a, p) => a + p.net, 0) }));
}

/** Printable payslip (ST-6). */
export async function getPayslip(actor: Actor, payslipId: string) {
  assertCan(actor, "payroll");
  const p = await prisma.payslip.findUnique({ where: { id: payslipId }, include: { run: true } });
  if (!p) throw new DomainError("NOT_FOUND", "Payslip was not found.");
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: p.employeeId }, include: { user: true } });
  return { ...p, name: e.user.name, role: e.user.role, phone: e.user.phone, joinDate: fromDbDate(e.joinDate), month: p.run.month, runStatus: p.run.status, daysInMonth: monthBounds(p.run.month).dim };
}
