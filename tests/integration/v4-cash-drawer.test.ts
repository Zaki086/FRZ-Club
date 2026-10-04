// v4 §2 Cash Drawer v2 — CD-1…CD-8, the safe and bank deposits, the daily reconciliation and integrity #12–#13.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, withTx } from "@/server/db";
import { createBill } from "@/server/services/bills";
import { getSettings } from "@/server/services/settings";
import { priceLine } from "@/server/services/pricing";
import { completeRefund, recordCounterPayment, refundTx } from "@/server/services/payments";
import {
  approveDrawerVariance, cashDrop, cashSummary, closeDrawer, createTill, dailyCashReconciliation, drawerBalanceTx, ensureTill, explainDrawerVariance, getDrawerSession,
  listDrawerVarianceApprovals, listTills, myDrawer, myDrawerBalance, openDrawer, payIn, payOut, recordBankDeposit, recordDeposit, rejectDrawerVariance,
  safeBalanceTx, safeSummary, updateTill,
} from "@/server/services/drawers";
import { runIntegrityChecks } from "@/server/services/integrity";
import { listView } from "@/server/services/filters";
import { SYSTEM, type UserActor } from "@/server/rbac/actor";
import { breakdownCounts } from "@/lib/cash";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { makeWorld, type World, utr, CARD_PROOF } from "../helpers/world";
import { expectIntegrity } from "../helpers/integrity";

let w: World;

async function makeBill(amount: number) {
  const s = await getSettings();
  const g = await prisma.guest.create({ data: { name: "Cash Carla" } });
  return withTx((tx) =>
    createBill(tx, {
      sourceType: "BOOKING",
      customer: { guestId: g.id, name: g.name },
      tier: "WALK_IN",
      lines: [priceLine({ description: "Court hour", qty: 1, unitPrice: amount, taxCategory: "COURT", hsnSac: "999652", explanation: "test" }, s)],
    }),
  );
}

/** Close the world's empty drawer and open `till` with a float counted by denomination. */
async function openTill(actor: UserActor, tillId: string, float: number) {
  const d = await myDrawer(actor);
  if (d.open) await closeDrawer(actor, { cashCounted: d.open.cashExpected });
  return openDrawer(actor, { drawerId: tillId, counts: breakdownCounts(float) });
}

// v6 TL-4 changed this (was: createTill): the world already has the club's tills ("Bar Till", "Shop Till", …), so a
// test asks for a till by name (idempotent) instead of adding a second one.
async function till(name: string, location: "FRONT_DESK" | "SHOP" | "BAR" = "FRONT_DESK", defaultFloat = 200000) {
  return ensureTill(w.actors.OWNER, { name, location, defaultFloat });
}

const balanceOf = async (actor: UserActor) => (await myDrawerBalance(actor)).open?.balancePaise ?? null;

beforeEach(async () => {
  w = await makeWorld();
});

describe("v4 §2.2 — the live balance (CD-1, CD-2)", () => {
  it("CD-1: a cash payment increments the drawer in the same transaction; card and UPI never touch the cash", async () => {
    const t = await till("Front Desk Till A");
    const s = await openTill(w.actors.FRONT_DESK, t.id, 100000);
    expect(await balanceOf(w.actors.FRONT_DESK)).toBe(100000);
    const bill = await makeBill(95000);
    const p = await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 55000 });
    expect(await balanceOf(w.actors.FRONT_DESK)).toBe(155000);
    const m = await prisma.drawerMovement.findFirstOrThrow({ where: { paymentId: p.paymentId } });
    expect([m.sessionId, m.type, m.amount, m.balanceAfter, m.lineNo]).toEqual([s.id, "CASH_SALE", 55000, 155000, 2]);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "UPI", amount: 20000, reference: utr() });
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CARD", amount: 20000, ...CARD_PROOF });
    expect(await withTx((tx) => drawerBalanceTx(tx, s.id))).toBe(155000);
    expect(await prisma.drawerMovement.count({ where: { sessionId: s.id } })).toBe(2);
    // A rejected payment writes nothing — the movement lives and dies with the payment's transaction.
    await expect(recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 1 })).rejects.toMatchObject({ code: "OVERPAYMENT" });
    expect(await prisma.drawerMovement.count({ where: { sessionId: s.id } })).toBe(2);
    // Append-only like the ledger.
    await expect(prisma.drawerMovement.update({ where: { id: m.id }, data: { amount: 1 } })).rejects.toThrow(/append-only/);
    await expect(prisma.drawerMovement.delete({ where: { id: m.id } })).rejects.toThrow(/append-only/);
    const live = await myDrawer(w.actors.FRONT_DESK);
    expect([live.open?.cashExpected, live.open?.summary.sales]).toEqual([155000, { count: 1, amount: 55000 }]);
    await expectIntegrity();
  });

  it("CD-2: DRAWER_NOT_OPEN — cash needs an open session for the acting staff member", async () => {
    await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 0 });
    const bill = await makeBill(30000);
    await expect(recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 30000 })).rejects.toMatchObject({ code: "DRAWER_NOT_OPEN" });
    await expect(payIn(w.actors.FRONT_DESK, { amount: 1000, reason: "change" })).rejects.toMatchObject({ code: "DRAWER_NOT_OPEN" });
    await expect(payOut(w.actors.FRONT_DESK, { amount: 1000, reason: "water", category: "OTHER" })).rejects.toMatchObject({ code: "DRAWER_NOT_OPEN" });
    await expect(cashDrop(w.actors.FRONT_DESK, { amount: 1000, bagRef: "B1" })).rejects.toMatchObject({ code: "DRAWER_NOT_OPEN" });
    expect(await myDrawerBalance(w.actors.FRONT_DESK)).toEqual({ open: null });
    expect(await prisma.payment.count({ where: { billId: bill.id } })).toBe(0);
  });

  it("CD-1/RF-9: a cash refund decrements the drawer; INSUFFICIENT_CASH_IN_DRAWER when it can't cover it", async () => {
    const t = await till("Front Desk Till A");
    await openTill(w.actors.FRONT_DESK, t.id, 20000);
    const bill = await makeBill(80000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 80000 });
    expect(await balanceOf(w.actors.FRONT_DESK)).toBe(100000);
    const r = await withTx((tx) => refundTx(tx, w.actors.FRONT_DESK, bill.id, 30000, { method: "CASH", reason: "rain", category: "SERVICE_ISSUE", policy: "TEST" }));
    expect([r.refunded, r.pending]).toEqual([30000, 0]);
    expect(await balanceOf(w.actors.FRONT_DESK)).toBe(70000);
    const mv = await prisma.drawerMovement.findFirstOrThrow({ where: { paymentId: r.refunds[0].id } });
    expect([mv.type, mv.amount, mv.balanceAfter]).toEqual(["CASH_REFUND", -30000, 70000]);
    // The manager's drawer is empty: asked to pay cash now → refused; the automatic "same way" refund waits at the desk.
    await expect(withTx((tx) => refundTx(tx, w.actors.MANAGER, bill.id, 10000, { method: "CASH", reason: "x", category: "GOODWILL", policy: "TEST" })))
      .rejects.toMatchObject({ code: "INSUFFICIENT_CASH_IN_DRAWER", details: { balance: 0, amount: 10000 } });
    const later = await withTx((tx) => refundTx(tx, w.actors.MANAGER, bill.id, 10000, { reason: "x", category: "GOODWILL", policy: "TEST" }));
    expect([later.refunded, later.pending]).toEqual([0, 10000]);
    await expect(completeRefund(w.actors.MANAGER, later.refunds[0].id, { method: "CASH" })).rejects.toMatchObject({ code: "INSUFFICIENT_CASH_IN_DRAWER" });
    await completeRefund(w.actors.FRONT_DESK, later.refunds[0].id, { method: "CASH" });
    expect(await balanceOf(w.actors.FRONT_DESK)).toBe(60000);
    await expectIntegrity();
  });
});

describe("v4 §2.2 — tendered and change (CD-3, CD-4)", () => {
  it("CD-3: the drawer grows by the amount applied, not the tendered amount; CD-4: INSUFFICIENT_CHANGE suggests a pay-in", async () => {
    const t = await till("Front Desk Till A");
    await openTill(w.actors.FRONT_DESK, t.id, 10000); // ₹100 of change
    const bill = await makeBill(110000);
    await expect(recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 55000, tendered: 200000 }))
      .rejects.toMatchObject({ code: "INSUFFICIENT_CHANGE", message: expect.stringMatching(/Pay in/), details: { change: 145000, balance: 10000 } });
    const ok = await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 55000, tendered: 60000 });
    expect(ok.changeGiven).toBe(5000);
    expect(await balanceOf(w.actors.FRONT_DESK)).toBe(65000); // ₹100 + ₹550, not + ₹600
    // Tendered stays optional (API back-compat); exact cash needs no change.
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 55000 });
    expect(await balanceOf(w.actors.FRONT_DESK)).toBe(120000);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: ok.paymentId } });
    expect([p.tendered, p.changeGiven]).toEqual([60000, 5000]);
  });
});

describe("v4 §2.1 — pay in, pay out, cash drop and the safe (§2.6)", () => {
  it("PAY_OUT creates an expense bill marked PAID by cash; PAY_IN and CASH_DROP move cash between the drawer and the safe", async () => {
    const t = await till("Front Desk Till A");
    const s = await openTill(w.actors.FRONT_DESK, t.id, 300000);
    const out = await payOut(w.actors.FRONT_DESK, { amount: 24000, reason: "Drinking water cans", category: "OTHER", paidTo: "Aqua Store" });
    const e = await prisma.expenseBill.findUniqueOrThrow({ where: { id: out.expenseId } });
    expect([e.status, e.method, e.amount, e.vendor, e.category]).toEqual(["PAID", "CASH", 24000, "Aqua Store", "OTHER"]);
    const led = await prisma.ledgerEntry.findFirstOrThrow({ where: { refType: "expense_bill", refId: e.id } });
    expect([led.direction, led.method, led.amount]).toEqual(["OUT", "CASH", -24000]);
    expect(out.balance).toBe(276000);
    await expect(payOut(w.actors.FRONT_DESK, { amount: 9_000_000, reason: "too much", category: "OTHER" })).rejects.toMatchObject({ code: "INSUFFICIENT_CASH_IN_DRAWER" });

    // The safe starts empty: a pay-in has nothing to come from.
    await expect(payIn(w.actors.FRONT_DESK, { amount: 10000, reason: "change" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/safe holds ₹0/) });
    await expect(cashDrop(w.actors.FRONT_DESK, { amount: 5000, bagRef: "" })).rejects.toThrow();
    await expect(cashDrop(w.actors.FRONT_DESK, { amount: 900000, bagRef: "B-7" })).rejects.toMatchObject({ code: "INSUFFICIENT_CASH_IN_DRAWER" });
    const drop = await cashDrop(w.actors.FRONT_DESK, { amount: 200000, bagRef: "B-7" });
    expect(drop.balance).toBe(76000);
    expect(await safeBalanceTx(prisma)).toBe(200000);
    const pin = await payIn(w.actors.FRONT_DESK, { amount: 50000, reason: "Change for the rush" });
    expect([pin.balance, await safeBalanceTx(prisma)]).toEqual([126000, 150000]);
    // Bank deposits come out of the safe (Owner/Manager/Accountant), never more than it holds.
    await expect(recordBankDeposit(w.actors.FRONT_DESK, { amount: 1000, depositDate: istDate(clock.now()), slipRef: "SLIP-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(recordBankDeposit(w.actors.ACCOUNTANT, { amount: 160000, depositDate: istDate(clock.now()), slipRef: "SLIP-1" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await recordBankDeposit(w.actors.MANAGER, { amount: 150000, depositDate: istDate(clock.now()), slipRef: "SLIP-1", note: "SBI branch" });
    const safe = await safeSummary(w.actors.ACCOUNTANT);
    expect(safe.balance).toBe(0);
    expect(safe.movements.map((m) => [m.type, m.amount, m.balanceAfter])).toEqual([["BANK_DEPOSIT", -150000, 0], ["PAY_IN", -50000, 150000], ["CASH_DROP", 200000, 200000]]);
    expect(safe.deposits.map((d) => [d.amount, d.slipRef])).toEqual([[150000, "SLIP-1"]]);
    const summary = (await myDrawer(w.actors.FRONT_DESK)).open!.summary;
    expect([summary.payOuts, summary.payIns, summary.drops]).toEqual([{ count: 1, amount: 24000 }, { count: 1, amount: 50000 }, { count: 1, amount: 200000 }]);
    expect((await getDrawerSession(w.actors.OWNER, s.id)).movements.map((m) => [m.type, m.balanceAfter])).toEqual([
      ["OPENING_FLOAT", 300000], ["PAY_OUT", 276000], ["CASH_DROP", 76000], ["PAY_IN", 126000],
    ]);
    await expectIntegrity();
  });
});

describe("v4 §2.5 — closing (CD-5 … CD-8)", () => {
  it("CD-5/CD-6: blind count by denomination; within the tolerance → CLOSED with a CLOSING_ADJUSTMENT; over it → approval", async () => {
    const t = await till("Front Desk Till A");
    expect((await myDrawer(w.actors.FRONT_DESK)).rules).toMatchObject({ blindClose: true, tolerance: 5000 });
    await openTill(w.actors.FRONT_DESK, t.id, 100000);
    const bill = await makeBill(55000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 55000 });
    // Counts are validated against the denominations in Settings.
    await expect(closeDrawer(w.actors.FRONT_DESK, { counts: [{ kind: "NOTE", value: 70000, count: 1 }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(closeDrawer(w.actors.FRONT_DESK, { counts: breakdownCounts(150000), cashCounted: 155000 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // The staff member never sends (or sees) the expected amount: only the count. ₹20 short → within ₹50.
    const c = await closeDrawer(w.actors.FRONT_DESK, { counts: breakdownCounts(153000), floatCarried: 100000, bagRef: "BAG-1" });
    expect([c.status, c.cashExpected, c.cashCounted, c.variance, c.needsApproval, c.floatCarried, c.cashDropped]).toEqual(["CLOSED", 155000, 153000, -2000, false, 100000, 53000]);
    const moves = await prisma.drawerMovement.findMany({ where: { sessionId: c.id }, orderBy: { lineNo: "asc" } });
    expect(moves.map((m) => [m.type, m.amount, m.balanceAfter, m.atClose])).toEqual([
      ["OPENING_FLOAT", 100000, 100000, false], ["CASH_SALE", 55000, 155000, false], ["CLOSING_ADJUSTMENT", -2000, 153000, true], ["CASH_DROP", -53000, 100000, true],
    ]);
    expect(await safeBalanceTx(prisma)).toBe(53000);
    expect(await prisma.notification.count({ where: { type: "CASH_VARIANCE" } })).toBeGreaterThan(0);

    // Over the tolerance: closed with the blind count, waits for approval; the reason is asked right after.
    await openTill(w.actors.FRONT_DESK, t.id, 100000);
    const c2 = await closeDrawer(w.actors.FRONT_DESK, { counts: breakdownCounts(90000), floatCarried: 90000 });
    expect([c2.status, c2.variance, c2.needsApproval, c2.needsReason]).toEqual(["PENDING_APPROVAL", -10000, true, true]);
    await expect(explainDrawerVariance(w.actors.SHOP_STAFF, c2.id, "not mine")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await explainDrawerVariance(w.actors.FRONT_DESK, c2.id, "A ₹100 note given as change twice");
    const items = await listDrawerVarianceApprovals(w.actors.MANAGER);
    expect(items).toEqual([expect.objectContaining({ kind: "DRAWER_VARIANCE", id: c2.id, amountPaise: -10000, requestedBy: "Farah Desk", href: `/app/finance/drawers/${c2.id}`, detail: expect.stringMatching(/given as change twice/) })]);
    expect(await listDrawerVarianceApprovals(w.actors.FRONT_DESK)).toEqual([]);
    expect(await prisma.notification.count({ where: { type: "DRAWER_VARIANCE" } })).toBeGreaterThan(0);
    await expect(approveDrawerVariance(w.actors.FRONT_DESK, c2.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rejectDrawerVariance(w.actors.MANAGER, c2.id, "")).rejects.toThrow();
    const ok = await approveDrawerVariance(w.actors.MANAGER, c2.id);
    expect([ok.status, ok.approvedBy]).toEqual(["APPROVED", w.actors.MANAGER.userId]);
    await expect(approveDrawerVariance(w.actors.OWNER, c2.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await listDrawerVarianceApprovals(w.actors.MANAGER)).toEqual([]);

    // Reject with a reason; nobody approves their own drawer.
    await openTill(w.actors.MANAGER, t.id, 50000);
    const c3 = await closeDrawer(w.actors.MANAGER, { counts: breakdownCounts(80000), varianceReason: "Found a ₹500 note under the tray" });
    expect([c3.status, c3.needsReason]).toEqual(["PENDING_APPROVAL", false]);
    expect(await listDrawerVarianceApprovals(w.actors.MANAGER)).toEqual([]);
    await expect(approveDrawerVariance(w.actors.MANAGER, c3.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const no = await rejectDrawerVariance(w.actors.OWNER, c3.id, "No receipt for it");
    expect([no.status, no.rejectionReason]).toEqual(["REJECTED", "No receipt for it"]);
    await expectIntegrity();
  });

  it("CD-7/CD-8: the float carried stays in the till; handover = close + open of the same till with no gap", async () => {
    const t = await till("Front Desk Till A", "FRONT_DESK", 150000);
    await openTill(w.actors.FRONT_DESK, t.id, 150000);
    const bill = await makeBill(60000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 60000 });
    // Two staff can't share one open drawer.
    await closeDrawer(w.actors.MANAGER, { cashCounted: 0 });
    await expect(openDrawer(w.actors.MANAGER, { drawerId: t.id, counts: breakdownCounts(150000) })).rejects.toMatchObject({ code: "DRAWER_IN_USE" });
    const morning = await closeDrawer(w.actors.FRONT_DESK, { counts: breakdownCounts(210000), floatCarried: 150000, bagRef: "BAG-AM" });
    expect([morning.cashDropped, morning.floatCarried, morning.status]).toEqual([60000, 150000, "CLOSED"]);
    const evening = await openDrawer(w.actors.MANAGER, { drawerId: t.id, counts: breakdownCounts(150000) });
    const a = await prisma.drawerMovement.findMany({ where: { sessionId: morning.id }, orderBy: { lineNo: "desc" }, take: 1 });
    const b = await prisma.drawerMovement.findFirstOrThrow({ where: { sessionId: evening.id, lineNo: 1 } });
    expect([a[0].balanceAfter, b.type, b.amount]).toEqual([150000, "OPENING_FLOAT", 150000]); // no gap
    expect(await prisma.notification.count({ where: { title: { startsWith: "Float differs" } } })).toBe(0);
    let rec = await dailyCashReconciliation(w.actors.ACCOUNTANT);
    expect(rec.lines.filter((l) => l.key.startsWith("handover"))).toEqual([]);
    // A different count at the next open is a handover difference (red in the reconciliation + a notification).
    await closeDrawer(w.actors.MANAGER, { counts: breakdownCounts(150000), floatCarried: 150000 });
    // v6 TL-1 changed this (was: the shop staff member took over this front desk till): shop staff can't open a front
    // desk till any more, so the Owner (any till) takes it over.
    await expect(openDrawer(w.actors.SHOP_STAFF, { drawerId: t.id, counts: breakdownCounts(140000) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); // has the Shop Till open
    await closeDrawer(w.actors.SHOP_STAFF, { cashCounted: 0 });
    await expect(openDrawer(w.actors.SHOP_STAFF, { drawerId: t.id, counts: breakdownCounts(140000) })).rejects.toMatchObject({ code: "DRAWER_AREA_MISMATCH" });
    await closeDrawer(w.actors.OWNER, { cashCounted: 0 });
    const next = await openDrawer(w.actors.OWNER, { drawerId: t.id, counts: breakdownCounts(140000) });
    rec = await dailyCashReconciliation(w.actors.ACCOUNTANT);
    expect(rec.lines.find((l) => l.key === `handover:${next.id}`)).toMatchObject({ expected: 150000, actual: 140000, difference: -10000, ok: false });
    expect(await prisma.notification.count({ where: { title: { startsWith: "Float differs" } } })).toBeGreaterThan(0);
    // Cash in the drawers now = open sessions + the float left in closed tills.
    expect((await cashSummary()).inDrawersNowPaise).toBe(140000);
    await expectIntegrity();
  });

  it("two staff can't share one open drawer — also at the database (one OPEN session per till and per person)", async () => {
    const t = await till("Bar Till", "BAR");
    await openTill(w.actors.BAR_STAFF, t.id, 0);
    await closeDrawer(w.actors.MANAGER, { cashCounted: 0 });
    await expect(openDrawer(w.actors.MANAGER, { drawerId: t.id, openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_IN_USE" });
    await expect(prisma.cashDrawerSession.create({ data: { userId: w.actors.MANAGER.userId, drawerId: t.id, area: "BAR", openingFloat: 0, openedAt: clock.now() } })).rejects.toThrow();
    await expect(openDrawer(w.actors.BAR_STAFF, { area: "BAR", openingFloat: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); // already has one
    const tills = await listTills(w.actors.MANAGER);
    expect(tills.find((x) => x.id === t.id)?.openSession).toMatchObject({ userName: "Bina Bar", mine: false });
    await expect(updateTill(w.actors.OWNER, t.id, { active: false })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(createTill(w.actors.MANAGER, { name: "Another", location: "BAR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createTill(w.actors.OWNER, { name: "bar till", location: "BAR" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  // v6 TL-4 changed this (was: "…or the next one there" — every busy location got the next numbered till, which is
  // how a shop login ended up with "Front Desk Till 4"): a free till at that location; never a new numbered till.
  it("legacy openDrawer({ area, openingFloat }) keeps working: a free till at that location — never a new numbered till", async () => {
    // The world opened Front Desk Till 1–3 for the Owner, the Manager and the front desk (each role at its own area).
    const desk = await prisma.cashDrawer.findMany({ where: { location: "FRONT_DESK" }, orderBy: { name: "asc" } });
    expect(desk.map((t) => t.name)).toEqual(["Front Desk Till 1", "Front Desk Till 2", "Front Desk Till 3"]);
    await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 0 });
    const again = await openDrawer(w.actors.FRONT_DESK, { area: "DESK", openingFloat: 50000 });
    expect(desk.map((t) => t.id)).toContain(again.drawerId);
    expect(await balanceOf(w.actors.FRONT_DESK)).toBe(50000);
    await closeDrawer(w.actors.SHOP_STAFF, { cashCounted: 0 });
    const shop = await openDrawer(w.actors.SHOP_STAFF, { area: "SHOP", openingFloat: 0 });
    expect((await prisma.cashDrawer.findUniqueOrThrow({ where: { id: shop.drawerId! } })).name).toBe("Shop Till");
    // Every front desk till is busy: the Manager's legacy open is refused instead of adding "Front Desk Till 4".
    await closeDrawer(w.actors.MANAGER, { cashCounted: 0 });
    await closeDrawer(w.actors.BAR_STAFF, { cashCounted: 0 });
    await openDrawer(w.actors.BAR_STAFF, { area: "BAR", openingFloat: 0 });
    await openDrawer(w.actors.MANAGER, { area: "DESK", openingFloat: 0 }); // Front Desk Till 2 is free again
    await closeDrawer(w.actors.MANAGER, { cashCounted: 0 });
    const { createStaff } = await import("@/server/services/users");
    const { SYSTEM } = await import("@/server/rbac/actor");
    const { user, employee } = await createStaff(SYSTEM, { name: "Extra Desk", phone: "9000000011", email: "desk2@test.club", role: "FRONT_DESK", password: "password123", monthlySalary: 2_000_000, joinDate: "2025-01-01" });
    await openDrawer({ kind: "USER", userId: user.id, role: "FRONT_DESK", name: "Extra Desk", memberId: null, employeeId: employee.id }, { area: "DESK", openingFloat: 0 }); // takes Till 2
    await expect(openDrawer(w.actors.MANAGER, { area: "DESK", openingFloat: 0 })).rejects.toMatchObject({ code: "DRAWER_IN_USE" });
    expect(await prisma.cashDrawer.count({ where: { location: "FRONT_DESK" } })).toBe(3);
  });
});

describe("v4 §2.6 — reconciliation and §2.7 integrity #12–#13", () => {
  it("every reconciliation line reconciles; a cash payment taken outside a drawer shows in red; the legacy session deposit still works", async () => {
    const t = await till("Front Desk Till A");
    await openTill(w.actors.FRONT_DESK, t.id, 100000);
    const bill = await makeBill(90000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 40000 });
    await withTx((tx) => refundTx(tx, w.actors.FRONT_DESK, bill.id, 10000, { method: "CASH", reason: "r", category: "GOODWILL", policy: "TEST" }));
    await cashDrop(w.actors.FRONT_DESK, { amount: 50000, bagRef: "B-1" });
    let rec = await dailyCashReconciliation(w.actors.ACCOUNTANT);
    expect(rec.lines.filter((l) => !l.ok)).toEqual([]);
    expect(rec.lines.find((l) => l.key === "cash_sales")).toMatchObject({ expected: 40000, actual: 40000 });
    expect(rec.lines.find((l) => l.key === "cash_refunds")).toMatchObject({ expected: 10000, actual: 10000 });
    expect(rec.lines.find((l) => l.key === "drops")).toMatchObject({ expected: 50000, actual: 50000 });
    // A cash payment recorded by the system (no drawer) is not in any drawer: the line shows the difference with a link.
    await recordCounterPayment(SYSTEM, { billId: bill.id, method: "CASH", amount: 20000 });
    rec = await dailyCashReconciliation(w.actors.ACCOUNTANT);
    expect(rec.lines.find((l) => l.key === "cash_sales")).toMatchObject({ expected: 60000, actual: 40000, difference: -20000, ok: false, href: expect.stringContaining("/app/finance/ledger") });
    expect(rec.totals.unreconciled).toBe(1);
    // v3 per-session deposit (kept): the closing drop went to the safe, so the deposit comes out of the safe.
    const closed = await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 80000, bagRef: "B-2" });
    await recordDeposit(w.actors.ACCOUNTANT, closed.id, { amount: 80000, reference: "DEP-9" });
    expect(await safeBalanceTx(prisma)).toBe(50000);
    expect((await listView(w.actors.MANAGER, "drawers", { q: "Front Desk Till A" })).rows.map((r) => [r.status, r.cash_expected])).toEqual([["CLOSED", 80000]]);
    await expect(dailyCashReconciliation(w.actors.FRONT_DESK)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("integrity #12 (sales/refunds = linked cash payments/refunds) and #13 (running balances, expected at close) — 13 checks", async () => {
    const t = await till("Front Desk Till A");
    const s = await openTill(w.actors.FRONT_DESK, t.id, 100000);
    const bill = await makeBill(90000);
    const p = await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 40000 });
    await closeDrawer(w.actors.FRONT_DESK, { cashCounted: 139000, floatCarried: 100000, bagRef: "B" });
    let checks = await runIntegrityChecks();
    // v6 WI-4 changed this (was: 13 checks): #14 accepts anonymous walk-in bills (customer kind WALK_IN).
    expect(checks.map((c) => c.id)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    // #12: a cash payment linked to a session without its CASH_SALE movement.
    const g = await prisma.guest.create({ data: { name: "Ghost" } });
    const b2 = await withTx(async (tx) => createBill(tx, { sourceType: "BOOKING", customer: { guestId: g.id, name: g.name }, tier: "WALK_IN", lines: [priceLine({ description: "x", qty: 1, unitPrice: 5000, taxCategory: "COURT", hsnSac: "999652", explanation: "x" }, await getSettings())] }));
    await prisma.payment.create({ data: { billId: b2.id, type: "PAYMENT", method: "CASH", amount: 5000, status: "SUCCEEDED", drawerSessionId: s.id, occurredAt: clock.now() } });
    checks = await runIntegrityChecks();
    expect(checks.find((c) => c.id === 12)?.ok).toBe(false);
    // #13: a movement whose running balance doesn't add up.
    await prisma.drawerMovement.create({ data: { sessionId: s.id, lineNo: 99, type: "PAY_IN", amount: 100, balanceAfter: 1, at: clock.now() } });
    checks = await runIntegrityChecks();
    expect(checks.find((c) => c.id === 13)).toMatchObject({ ok: false, detail: expect.stringContaining("running") });
    expect(p.paymentId).toBeTruthy();
  });

  it("RN-5: cash summary — collected today, in the drawers now, in the safe", async () => {
    const t = await till("Front Desk Till A");
    await openTill(w.actors.FRONT_DESK, t.id, 100000);
    const bill = await makeBill(90000);
    await recordCounterPayment(w.actors.FRONT_DESK, { billId: bill.id, method: "CASH", amount: 40000 });
    await cashDrop(w.actors.FRONT_DESK, { amount: 30000, bagRef: "B-1" });
    expect(await cashSummary()).toEqual({ collectedTodayPaise: 40000, inDrawersNowPaise: 110000, inSafePaise: 30000 });
  });
});

describe("seed:demo — the sample tills (run through the seed's own drawer routine)", () => {
  it("creates Front Desk Till 1, Shop Till and Bar Till; the 14:00 handover leaves no gap; the night close carries the float and drops the rest", async () => {
    const { resetDb } = await import("../helpers/db");
    const { seedBase } = await import("../../prisma/seed/base");
    const { closeDrawers, handoverDesk, onDuty, openDrawers } = await import("../../prisma/seed/history");
    const { istToUtc } = await import("@/lib/time");
    await resetDb();
    process.env.SEED_STAFF_PASSWORD ??= "seed-test-password";
    process.env.SEED_MEMBER_PASSWORD ??= "seed-test-password";
    clock.set(istToUtc("2026-10-12", "05:00"));
    const staff = onDuty(await seedBase("2025-01-01"));
    await openDrawers(staff);
    const open = await prisma.cashDrawerSession.findMany({ where: { closedAt: null }, orderBy: { openedAt: "asc" } });
    const names = await prisma.cashDrawer.findMany({ orderBy: { name: "asc" } });
    expect(names.map((t) => [t.name, t.location, t.defaultFloat])).toEqual([["Bar Till", "BAR", 200000], ["Front Desk Till 1", "FRONT_DESK", 200000], ["Shop Till", "SHOP", 100000]]);
    expect(open.map((s) => s.openingFloat)).toEqual([200000, 100000, 200000]);
    expect(staff.desk.name).toBe("Farah Khan");
    const bill = await makeBill(55000);
    await recordCounterPayment(staff.desk, { billId: bill.id, method: "CASH", amount: 55000, tendered: 60000 });
    clock.set(istToUtc("2026-10-12", "14:00"));
    await handoverDesk(staff, false);
    expect(staff.desk.name).toBe("Dev Patel");
    const deskTill = names.find((t) => t.name === "Front Desk Till 1")!.id;
    const [evening, morning] = await prisma.cashDrawerSession.findMany({ where: { drawerId: deskTill }, orderBy: { openedAt: "desc" } });
    expect([morning.status, morning.cashCounted, morning.floatCarried, morning.cashDropped]).toEqual(["CLOSED", 255000, 200000, 55000]);
    expect([evening.closedAt, evening.openingFloat]).toEqual([null, 200000]);
    clock.set(istToUtc("2026-10-12", "23:50"));
    await closeDrawers(staff, false);
    expect(await prisma.cashDrawerSession.count({ where: { closedAt: null } })).toBe(0);
    expect(await safeBalanceTx(prisma)).toBe(55000);
    clock.set(istToUtc("2026-10-13", "05:00"));
    await openDrawers(staff);
    expect((await prisma.cashDrawerSession.findFirstOrThrow({ where: { drawerId: deskTill, closedAt: null } })).userId).toBe(staff.desk.userId);
    await expectIntegrity();
  });
});
