// v3 phase 8 (§3.2): the finance lists on the shared FilterBar engine — invoices, business clients, expenses,
// payroll runs and the ledger. Each list runs, a facet narrows with the right count, the summary strip adds up for a
// small fixture, and a role that may not see the list is refused.
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { listView } from "@/server/services/filters";
import { createClient, createDraft, issueInvoice } from "@/server/services/invoices";
import { cancelExpense, createExpense, payExpense } from "@/server/services/expenses";
import { approvePayrollRun, createPayrollRun, payPayrollRun } from "@/server/services/payroll";
import { recordCounterPayment } from "@/server/services/payments";
import { tallyRows } from "@/server/services/reports";
import { makeWorld, utr, type World } from "../helpers/world";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

type Data = Awaited<ReturnType<typeof listView>>;
const sum = (d: Data, key: string) => d.summary.find((s) => s.key === key)?.value;
const count = (d: Data, facet: string, value: string) => d.facets.find((f) => f.key === facet)?.options.find((o) => o.value === value)?.count;
const ids = (d: Data) => d.rows.map((r) => r.id as string).sort();

describe("v3 §3.2 — finance lists", () => {
  it("invoices: status (with derived overdue), client and type facets; issued / outstanding / overdue / drafts", async () => {
    const mum = await createClient(w.actors.ACCOUNTANT, { name: "Mumbai Corp", gstin: "27AAPFU0939F1ZV", address: "Nariman Point, Mumbai", contactName: "Ravi" });
    const ahm = await createClient(w.actors.ACCOUNTANT, { name: "Ahmedabad Textiles", gstin: "24AABCT1332L1ZK", address: "Ashram Road, Ahmedabad", contactName: "Nisha", paymentTermsDays: 30 });
    const d1 = await createDraft(w.actors.ACCOUNTANT, { businessClientId: mum.id, lines: [{ kind: "MANUAL", description: "Corporate court package", qty: 1, unitPrice: 5_900_000 }] });
    const d2 = await createDraft(w.actors.ACCOUNTANT, { businessClientId: ahm.id, lines: [{ kind: "MANUAL", description: "Team event", qty: 2, unitPrice: 1_180_000 }] });
    const d3 = await createDraft(w.actors.ACCOUNTANT, { businessClientId: ahm.id, lines: [{ kind: "MANUAL", description: "Next event", qty: 1, unitPrice: 1_000_000 }] });
    await issueInvoice(w.actors.ACCOUNTANT, d1.invoice.id); // due in 15 days (27 Oct)
    await issueInvoice(w.actors.ACCOUNTANT, d2.invoice.id); // due in 30 days (11 Nov)
    await recordCounterPayment(w.actors.ACCOUNTANT, { billId: d2.bill.id, method: "BANK_TRANSFER", amount: 360_000, reference: "NEFT12345" });
    clock.set(istToUtc("2026-10-28", "09:00")); // d1 is now overdue; d2 is not

    const all = await listView(w.actors.ACCOUNTANT, "invoices", { kind: "BUSINESS" });
    expect(all.total).toBe(3);
    expect(sum(all, "issued")).toBe(5_900_000 + 2_360_000);
    expect(sum(all, "outstanding")).toBe(5_900_000 + 2_000_000);
    expect(sum(all, "overdue")).toBe(1);
    expect(sum(all, "drafts")).toBe(1);

    // The old `?status=OVERDUE` link: only the overdue invoice; an overdue invoice still counts as ISSUED.
    const overdue = await listView(w.actors.ACCOUNTANT, "invoices", { status: "OVERDUE" });
    expect(ids(overdue)).toEqual([d1.invoice.id]);
    expect([count(overdue, "status", "DRAFT"), count(overdue, "status", "ISSUED"), count(overdue, "status", "PARTIALLY_PAID"), count(overdue, "status", "OVERDUE")]).toEqual([1, 1, 1, 1]);
    expect((await listView(w.actors.ACCOUNTANT, "invoices", { status: "ISSUED" })).total).toBe(1);

    // The old `?clientId=` link from the clients page.
    const ahmOnly = await listView(w.actors.MANAGER, "invoices", { clientId: ahm.id });
    expect(ids(ahmOnly)).toEqual([d2.invoice.id, d3.invoice.id].sort());
    expect(count(ahmOnly, "clientId", mum.id)).toBe(1);

    await expect(listView(w.actors.BAR_STAFF, "invoices", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listView(w.actors.FRONT_DESK, "invoices", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("clients: outstanding and active facets; archived clients are hidden by default", async () => {
    const mum = await createClient(w.actors.ACCOUNTANT, { name: "Mumbai Corp", gstin: "27AAPFU0939F1ZV", address: "Nariman Point, Mumbai", contactName: "Ravi" });
    const ahm = await createClient(w.actors.ACCOUNTANT, { name: "Ahmedabad Textiles", gstin: "24AABCT1332L1ZK", address: "Ashram Road, Ahmedabad", contactName: "Nisha" });
    const old = await createClient(w.actors.ACCOUNTANT, { name: "Old Partners", gstin: "24AABCS1429B1Z0", address: "CG Road, Ahmedabad", contactName: "Om" });
    await prisma.businessClient.update({ where: { id: old.id }, data: { archivedAt: clock.now() } });
    const d = await createDraft(w.actors.ACCOUNTANT, { businessClientId: ahm.id, lines: [{ kind: "MANUAL", description: "Team event", qty: 2, unitPrice: 1_180_000 }] });
    await issueInvoice(w.actors.ACCOUNTANT, d.invoice.id);
    await recordCounterPayment(w.actors.ACCOUNTANT, { billId: d.bill.id, method: "BANK_TRANSFER", amount: 360_000, reference: "NEFT55555" });

    const def = await listView(w.actors.ACCOUNTANT, "clients", {});
    expect(ids(def)).toEqual([mum.id, ahm.id].sort());
    expect(sum(def, "clients")).toBe(2);
    expect(sum(def, "owing")).toBe(1);
    expect(sum(def, "outstanding")).toBe(2_000_000);
    expect(count(def, "outstanding", "yes")).toBe(1);

    const owing = await listView(w.actors.MANAGER, "clients", { outstanding: "yes" });
    expect(ids(owing)).toEqual([ahm.id]);
    expect(owing.rows[0].outstanding).toBe(2_000_000);
    expect(ids(await listView(w.actors.ACCOUNTANT, "clients", { active: "archived" }))).toEqual([old.id]);

    await expect(listView(w.actors.FRONT_DESK, "clients", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("expenses: status (with derived overdue), category, vendor, bill attached; unpaid / overdue / no bill", async () => {
    const e1 = await createExpense(w.actors.ACCOUNTANT, { vendor: "GUVNL", category: "UTILITIES", amount: 4_500_000, billDate: "2026-09-01", dueDate: "2026-09-16" });
    const e2 = await createExpense(w.actors.ACCOUNTANT, { vendor: "Landlord", category: "RENT", amount: 10_000_000, billDate: "2026-10-10" });
    const e3 = await createExpense(w.actors.ACCOUNTANT, { vendor: "GUVNL", category: "UTILITIES", amount: 1_000_000, billDate: "2026-10-01" });
    const e4 = await createExpense(w.actors.ACCOUNTANT, { vendor: "Print Shop", category: "MARKETING", amount: 200_000 });
    await payExpense(w.actors.ACCOUNTANT, e3.id, { method: "BANK_TRANSFER" });
    await cancelExpense(w.actors.ACCOUNTANT, e4.id, "duplicate bill");
    await prisma.expenseBill.update({ where: { id: e2.id }, data: { attachmentUrl: "/api/uploads/expense/aaaaaaaaaaaaaaaaaaaaaaaa.pdf" } });

    const all = await listView(w.actors.ACCOUNTANT, "expenses", {});
    expect(all.total).toBe(4);
    expect(sum(all, "unpaid")).toBe(14_500_000);
    expect(sum(all, "overdue")).toBe(4_500_000);
    expect(sum(all, "overdueBills")).toBe(1);
    expect(sum(all, "noBill")).toBe(2); // e1 and e3 (cancelled bills do not count)

    // The overdue-expenses notification links to `?status=OVERDUE`; the dashboard to `?status=UNPAID`.
    expect(ids(await listView(w.actors.ACCOUNTANT, "expenses", { status: "OVERDUE" }))).toEqual([e1.id]);
    expect(ids(await listView(w.actors.MANAGER, "expenses", { status: "UNPAID" }))).toEqual([e1.id, e2.id].sort());

    const guvnl = await listView(w.actors.ACCOUNTANT, "expenses", { vendor: "GUVNL" });
    expect(ids(guvnl)).toEqual([e1.id, e3.id].sort());
    expect([count(guvnl, "status", "UNPAID"), count(guvnl, "status", "OVERDUE"), count(guvnl, "status", "PAID"), count(guvnl, "status", "CANCELLED")]).toEqual([1, 1, 1, 0]);
    expect(count(guvnl, "vendor", "Landlord")).toBe(1);
    expect(ids(await listView(w.actors.ACCOUNTANT, "expenses", { bill: "yes" }))).toEqual([e2.id]);
    expect((await listView(w.actors.ACCOUNTANT, "expenses", { category: "UTILITIES,RENT" })).total).toBe(3);

    await expect(listView(w.actors.FRONT_DESK, "expenses", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("payroll: status, year and month facets; awaiting approval / approved / paid out", async () => {
    const sep = await createPayrollRun(w.actors.ACCOUNTANT, "2026-09");
    const oct = await createPayrollRun(w.actors.ACCOUNTANT, "2026-10");
    await approvePayrollRun(w.actors.OWNER, sep.id);
    await payPayrollRun(w.actors.ACCOUNTANT, sep.id, { method: "BANK_TRANSFER" });
    const net = async (runId: string) => (await prisma.payslip.aggregate({ where: { runId }, _sum: { net: true } }))._sum.net ?? 0;
    const [sepNet, octNet] = [await net(sep.id), await net(oct.id)];
    expect(sepNet).toBeGreaterThan(0);

    const all = await listView(w.actors.OWNER, "payroll", {});
    expect(all.total).toBe(2);
    expect(all.rows.map((r) => r.month)).toEqual(["2026-10", "2026-09"]);
    expect(sum(all, "draft")).toBe(1);
    expect(sum(all, "approved")).toBe(0);
    expect(sum(all, "paid")).toBe(sepNet);
    expect(sum(all, "net")).toBe(sepNet + octNet);
    expect(all.rows.find((r) => r.id === oct.id)?.employees).toBe(await prisma.payslip.count({ where: { runId: oct.id } }));

    const paid = await listView(w.actors.ACCOUNTANT, "payroll", { status: "PAID" });
    expect(ids(paid)).toEqual([sep.id]);
    expect([count(paid, "status", "DRAFT"), count(paid, "status", "PAID"), count(paid, "year", "2026")]).toEqual([1, 1, 1]);
    expect(ids(await listView(w.actors.ACCOUNTANT, "payroll", { month: "2026-10" }))).toEqual([oct.id]);

    await expect(listView(w.actors.MANAGER, "payroll", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ledger: opens on today; source, method and direction facets; money in / out / net; Tally follows the filters", async () => {
    const c = await createClient(w.actors.ACCOUNTANT, { name: "Mumbai Corp", gstin: "27AAPFU0939F1ZV", address: "Nariman Point, Mumbai", contactName: "Ravi" });
    const d = await createDraft(w.actors.ACCOUNTANT, { businessClientId: c.id, lines: [{ kind: "MANUAL", description: "Package", qty: 1, unitPrice: 1_180_000 }] });
    await issueInvoice(w.actors.ACCOUNTANT, d.invoice.id);
    await recordCounterPayment(w.actors.ACCOUNTANT, { billId: d.bill.id, method: "BANK_TRANSFER", amount: 1_180_000, reference: "NEFT77509" });
    const e = await createExpense(w.actors.ACCOUNTANT, { vendor: "Water Co", category: "UTILITIES", amount: 120_000 });
    await payExpense(w.actors.ACCOUNTANT, e.id, { method: "UPI", reference: utr() });

    const today = await listView(w.actors.ACCOUNTANT, "ledger", {});
    expect(today.query.range).toBe("TODAY");
    expect(today.total).toBe(2);
    expect(sum(today, "in")).toBe(1_180_000);
    expect(sum(today, "out")).toBe(120_000);
    expect(sum(today, "net")).toBe(1_060_000);
    expect([count(today, "source", "INVOICE"), count(today, "source", "EXPENSE"), count(today, "method", "UPI")]).toEqual([1, 1, 1]);

    const out = await listView(w.actors.OWNER, "ledger", { range: "TODAY", direction: "OUT" });
    expect(out.total).toBe(1);
    expect(out.rows[0]).toMatchObject({ source: "EXPENSE", method: "UPI", amount: -120_000 });
    expect(count(out, "direction", "IN")).toBe(1);
    expect((await listView(w.actors.ACCOUNTANT, "ledger", { range: "YESTERDAY" })).total).toBe(0);

    // The Tally day book takes the list's filters (date preset, comma-separated facets).
    expect((await tallyRows(w.actors.ACCOUNTANT, { range: "TODAY", direction: "OUT" })).map((r) => r.ledger)).toEqual(["Expenses"]);
    expect((await tallyRows(w.actors.ACCOUNTANT, { range: "ALL", source: "INVOICE,EXPENSE" })).length).toBe(2);
    expect((await tallyRows(w.actors.ACCOUNTANT, { range: "YESTERDAY" })).length).toBe(0);

    await expect(listView(w.actors.MANAGER, "ledger", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
