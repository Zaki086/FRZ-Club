import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { assignShift, decideLeave, fillShift, requestLeave } from "@/server/services/staff";
import { approvePayrollRun, createPayrollRun, payPayrollRun } from "@/server/services/payroll";
import { createClient, createDraft, getInvoice, issueInvoice, listInvoices, markOverdueInvoices } from "@/server/services/invoices";
import { createExpense, payExpense } from "@/server/services/expenses";
import { recordCounterPayment } from "@/server/services/payments";
import { gstReport } from "@/server/services/reports";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

describe("Phase 7 — roster and leave (ST-2, ST-4, ST-5; R-32, R-43, R-47)", () => {
  it("ST-2: overlapping shifts for one employee → SHIFT_OVERLAP (exclusion constraint); other employees are fine", async () => {
    const bar = w.actors.BAR_STAFF.employeeId!;
    await assignShift(w.actors.MANAGER, { employeeId: bar, date: "2026-10-14", startTime: "16:00", endTime: "23:00", area: "BAR" });
    await expect(assignShift(w.actors.MANAGER, { employeeId: bar, date: "2026-10-14", startTime: "22:00", endTime: "23:30", area: "KITCHEN" })).rejects.toMatchObject({
      code: "SHIFT_OVERLAP",
      message: expect.stringMatching(/already has a bar shift on 14 Oct 2026 16:00–23:00/),
    });
    await assignShift(w.actors.MANAGER, { employeeId: w.actors.SHOP_STAFF.employeeId!, date: "2026-10-14", startTime: "16:00", endTime: "23:00", area: "SHOP" });
    await expect(assignShift(w.actors.FRONT_DESK, { employeeId: bar, date: "2026-10-15", startTime: "10:00", endTime: "12:00", area: "BAR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ST-4: approving leave unassigns overlapping shifts (OPEN) and asks the manager to refill; no shifts during leave (LEAVE_CONFLICT)", async () => {
    const desk = w.actors.FRONT_DESK;
    const s1 = await assignShift(w.actors.MANAGER, { employeeId: desk.employeeId!, date: "2026-10-20", startTime: "06:00", endTime: "14:00", area: "FRONT_DESK" });
    const lr = await requestLeave(desk, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-21", reason: "family function" });
    await expect(decideLeave(desk, lr.id, "APPROVED")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const d = await decideLeave(w.actors.MANAGER, lr.id, "APPROVED");
    expect(d.unassignedShifts).toBe(1);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: s1.id } })).status).toBe("OPEN");
    expect(await prisma.notification.count({ where: { type: "SHIFT_UNASSIGNED" } })).toBeGreaterThan(0);
    await expect(assignShift(w.actors.MANAGER, { employeeId: desk.employeeId!, date: "2026-10-21", startTime: "06:00", endTime: "14:00", area: "FRONT_DESK" })).rejects.toMatchObject({ code: "LEAVE_CONFLICT" });
    await fillShift(w.actors.MANAGER, s1.id, w.actors.MANAGER.employeeId!);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: s1.id } })).status).toBe("ASSIGNED");
  });

  it("ST-5: beyond 12 casual days a request must be UNPAID (LEAVE_BALANCE_EXCEEDED)", async () => {
    const me = w.actors.SHOP_STAFF;
    await requestLeave(me, { type: "CASUAL", startDate: "2026-11-02", endDate: "2026-11-11", reason: "trip" }); // 10 days
    await expect(requestLeave(me, { type: "CASUAL", startDate: "2026-11-16", endDate: "2026-11-18", reason: "more" })).rejects.toMatchObject({
      code: "LEAVE_BALANCE_EXCEEDED",
      message: expect.stringMatching(/Only 2 of 12 casual days are left/),
    });
    expect((await requestLeave(me, { type: "UNPAID", startDate: "2026-11-16", endDate: "2026-11-18", reason: "more" })).days).toBe(3);
  });
});

describe("Phase 7 — payroll (ST-6, ST-7, R-42)", () => {
  it("ST-6: unpaid leave is deducted; the owner approves; paying writes PAYROLL ledger entries", async () => {
    const shop = w.actors.SHOP_STAFF; // salary ₹30,000 in the world fixture
    const lr = await requestLeave(shop, { type: "UNPAID", startDate: "2026-10-27", endDate: "2026-10-29", reason: "personal" });
    await decideLeave(w.actors.MANAGER, lr.id, "APPROVED");
    const run = await createPayrollRun(w.actors.ACCOUNTANT, "2026-10");
    const slip = run.payslips.find((p) => p.employeeId === shop.employeeId)!;
    expect([slip.gross, slip.unpaidDays, slip.deductions, slip.net]).toEqual([3_000_000, 3, 290_323, 2_709_677]);
    await expect(createPayrollRun(w.actors.ACCOUNTANT, "2026-10")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(payPayrollRun(w.actors.ACCOUNTANT, run.id)).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
    await expect(approvePayrollRun(w.actors.ACCOUNTANT, run.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await approvePayrollRun(w.actors.OWNER, run.id);
    const paid = await payPayrollRun(w.actors.ACCOUNTANT, run.id, { method: "ONLINE" });
    expect(paid.status).toBe("PAID");
    const sum = await prisma.ledgerEntry.aggregate({ where: { source: "PAYROLL" }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(-paid.totals.net);
  });

  it("ST-7/RBAC: payroll is visible only to OWNER and ACCOUNTANT", async () => {
    await expect(createPayrollRun(w.actors.MANAGER, "2026-10")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createPayrollRun(w.actors.BAR_STAFF, "2026-10")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Phase 7 — business clients, invoices, GST (IN-1…IN-6, R-40, R-41, R-44)", () => {
  it("IN-1: GSTIN format is validated and its first two digits give the state code", async () => {
    await expect(createClient(w.actors.ACCOUNTANT, { name: "Bad Co", gstin: "XX123", address: "Somewhere long enough", contactName: "Pat" })).rejects.toThrow(/GSTIN must be 15 characters/);
    const c = await createClient(w.actors.ACCOUNTANT, { name: "Mumbai Corp", gstin: "27AAPFU0939F1ZV", address: "Nariman Point, Mumbai", contactName: "Ravi" });
    expect(c.stateCode).toBe("27");
  });

  it("IN-2/IN-3: an inter-state B2B invoice uses IGST; intra-state uses CGST + SGST; FY numbering; partial → PARTIALLY_PAID → PAID", async () => {
    const mum = await createClient(w.actors.ACCOUNTANT, { name: "Mumbai Corp", gstin: "27AAPFU0939F1ZV", address: "Nariman Point, Mumbai", contactName: "Ravi", contactEmail: "ravi@mumbaicorp.test" });
    const ahm = await createClient(w.actors.ACCOUNTANT, { name: "Ahmedabad Textiles", gstin: "24AABCT1332L1ZB", address: "Ashram Road, Ahmedabad", contactName: "Nisha" });
    const d1 = await createDraft(w.actors.ACCOUNTANT, { businessClientId: mum.id, lines: [{ kind: "MANUAL", description: "Corporate court package — October", qty: 1, unitPrice: 5_900_000 }] });
    const d2 = await createDraft(w.actors.ACCOUNTANT, { businessClientId: ahm.id, lines: [{ kind: "MANUAL", description: "Team event", qty: 2, unitPrice: 1_180_000 }] });
    const i1 = await issueInvoice(w.actors.ACCOUNTANT, d1.invoice.id);
    const i2 = await issueInvoice(w.actors.ACCOUNTANT, d2.invoice.id);
    expect([i1.number, i2.number]).toEqual(["CC/2026-27/00001", "CC/2026-27/00002"]);
    const v1 = await getInvoice(w.actors.ACCOUNTANT, d1.invoice.id);
    expect(v1.totals).toMatchObject({ igst: 900_000, cgst: 0, sgst: 0, taxable: 5_000_000 });
    const v2 = await getInvoice(w.actors.ACCOUNTANT, d2.invoice.id);
    expect(v2.totals).toMatchObject({ igst: 0, cgst: 180_000, sgst: 180_000 });
    await recordCounterPayment(w.actors.ACCOUNTANT, { billId: d1.bill.id, method: "UPI", amount: 2_000_000, reference: "NEFT1" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: d1.invoice.id } })).status).toBe("PARTIALLY_PAID");
    await recordCounterPayment(w.actors.ACCOUNTANT, { billId: d1.bill.id, method: "UPI", amount: 3_900_000, reference: "NEFT2" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: d1.invoice.id } })).status).toBe("PAID");
    await expectIntegrity();
  });

  it("IN-2: OVERDUE is derived after the due date and notified once", async () => {
    const c = await createClient(w.actors.ACCOUNTANT, { name: "Slow Payer Ltd", gstin: "24AABCS1429B1ZB", address: "CG Road, Ahmedabad", contactName: "Om", paymentTermsDays: 15 });
    const d = await createDraft(w.actors.ACCOUNTANT, { businessClientId: c.id, lines: [{ kind: "MANUAL", description: "Annual corporate membership", qty: 1, unitPrice: 10_000_000 }] });
    await issueInvoice(w.actors.ACCOUNTANT, d.invoice.id);
    clock.set(istToUtc("2026-10-28", "09:00"));
    expect((await listInvoices(w.actors.ACCOUNTANT, { status: "OVERDUE" })).length).toBe(1);
    expect(await markOverdueInvoices()).toBe(1);
    expect(await markOverdueInvoices()).toBe(0);
  });

  it("IN-6: the GST report splits tax by rate and CGST/SGST vs IGST; RBAC blocks bar staff", async () => {
    const m = await makeMember(w, { name: "Gst Member", plan: "SILVER" }); // ₹2,000 membership @18% (intra-state)
    const mum = await createClient(w.actors.ACCOUNTANT, { name: "Mumbai Corp", gstin: "27AAPFU0939F1ZV", address: "Nariman Point, Mumbai", contactName: "Ravi" });
    const d = await createDraft(w.actors.ACCOUNTANT, { businessClientId: mum.id, lines: [{ kind: "MANUAL", description: "Package", qty: 1, unitPrice: 1_180_000 }] });
    await issueInvoice(w.actors.ACCOUNTANT, d.invoice.id);
    await recordCounterPayment(w.actors.ACCOUNTANT, { billId: d.bill.id, method: "UPI", amount: 1_180_000 });
    void m;
    const g = await gstReport(w.actors.ACCOUNTANT, { period: "TODAY" });
    expect(g.ratesVerified).toBe(false);
    expect(g.totals.tax).toBe(30508 + 180000);
    expect(g.totals.igst).toBe(180000);
    expect(g.totals.cgst + g.totals.sgst).toBe(30508);
    await expect(gstReport(w.actors.BAR_STAFF, { period: "TODAY" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("EX-1: expenses are created and paid by OWNER/ACCOUNTANT; the Manager can only view", async () => {
    await expect(createExpense(w.actors.MANAGER, { vendor: "GUVNL", category: "UTILITIES", amount: 4_500_000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const e = await createExpense(w.actors.ACCOUNTANT, { vendor: "GUVNL", category: "UTILITIES", amount: 4_500_000, inputGst: 0 });
    await payExpense(w.actors.OWNER, e.id, { method: "ONLINE" });
    await expect(payExpense(w.actors.OWNER, e.id, { method: "ONLINE" })).rejects.toMatchObject({ code: "ORDER_STATE_INVALID" });
  });
});
