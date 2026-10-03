// Bar & cafeteria POS (plan §5.9 BR-1…BR-11; R-25…R-33; E-11…E-15).
import type { MenuCategory, Prisma, TabLineStatus } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { CODE_SEQUENCE, formatCode, normalisePhone } from "@/lib/codes";
import { formatINR } from "@/lib/money";
import { ageOn, dbDate, fromDbDate, istDate, istDayRange, isValidDateStr, MINUTE } from "@/lib/time";
import { nextSeq, pgErrorCode, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { actorId, actorKey, type Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { addBillLines, billDue, createBill, netPaid, refreshBill, voidBillLines } from "./bills";
import { findOrCreateGuest } from "./guests";
import { idempotent } from "./idempotency";
import { recordSplitPaymentsTx, refundTx } from "./payments";
import { entitlementsFor, quoteBar } from "./pricing";

// ───────────── tabs (BR-3) ─────────────

export const openTabSchema = z.object({
  memberId: z.string().optional(),
  guest: z.object({ name: z.string().trim().min(2).max(100), phone: z.string().optional() }).optional(),
  tableId: z.string().optional().nullable(),
  guestIdVerified: z.boolean().default(false),
});

export async function openTabTx(tx: Tx, actor: Actor, raw: z.input<typeof openTabSchema>) {
  assertCan(actor, "bar.operate");
  const input = openTabSchema.parse(raw);
  if (!!input.memberId === !!input.guest) throw new DomainError("VALIDATION_FAILED", "A tab needs exactly one payer: a member or a named guest.");
  const today = istDate(clock.now());
  let memberId: string | null = null;
  let guestId: string | null = null;
  let name: string;
  if (input.memberId) {
    const m = await tx.member.findUnique({ where: { id: input.memberId } });
    if (!m) throw new DomainError("NOT_FOUND", "Member was not found.");
    const open = await tx.tab.findFirst({ where: { memberId: m.id, status: "OPEN" } });
    if (open) throw new DomainError("TAB_ALREADY_OPEN", `${m.name} already has an open tab (${open.code}). Add items to it instead.`, { tabId: open.id });
    memberId = m.id;
    name = m.name;
  } else {
    const phone = input.guest!.phone ? normalisePhone(input.guest!.phone) : null;
    const g = await findOrCreateGuest(tx, { name: input.guest!.name, phone });
    guestId = g.id;
    name = input.guest!.name;
  }
  if (input.tableId && !(await tx.barTable.findUnique({ where: { id: input.tableId } }))) throw new DomainError("NOT_FOUND", "Table was not found.");
  const ent = await entitlementsFor(tx, { memberId }, today);
  const code = formatCode("tab", await nextSeq(tx, CODE_SEQUENCE.tab));
  const bill = await createBill(tx, { sourceType: "BAR_TAB", customer: { memberId, guestId, name }, tier: ent.tier, lines: [], createdBy: actorId(actor) });
  let tab;
  try {
    tab = await tx.tab.create({
      data: {
        code, memberId, guestId, tableId: input.tableId ?? null, guestIdVerified: !!guestId && input.guestIdVerified,
        openedBy: actorId(actor) ?? "system", billId: bill.id, barDate: dbDate(today),
      },
    });
  } catch (e) {
    if (pgErrorCode(e) === "23505") throw new DomainError("TAB_ALREADY_OPEN", `${name} already has an open tab.`);
    throw e;
  }
  await tx.bill.update({ where: { id: bill.id }, data: { sourceId: tab.id } });
  if (guestId && input.guestIdVerified) await tx.guest.update({ where: { id: guestId }, data: { idVerifiedAt: clock.now() } });
  await audit(tx, actor, "tab.open", "tab", tab.id, { after: { code, payer: name, tier: ent.tier, tableId: input.tableId ?? null } });
  return { tabId: tab.id, code, payer: name, tier: ent.tier, billId: bill.id };
}

export async function openTab(actor: Actor, raw: z.input<typeof openTabSchema>, idempotencyKey?: string | null) {
  return withTx((tx) => idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "bar.open_tab", body: raw }, () => openTabTx(tx, actor, raw)));
}

async function lockTab(tx: Tx, tabId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tabs WHERE id = ${tabId} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Tab was not found.");
  return tx.tab.findUniqueOrThrow({ where: { id: tabId } });
}

async function payerName(tx: Tx | typeof prisma, tab: { memberId: string | null; guestId: string | null }) {
  if (tab.memberId) return (await tx.member.findUniqueOrThrow({ where: { id: tab.memberId } })).name;
  return (await tx.guest.findUniqueOrThrow({ where: { id: tab.guestId! } })).name;
}

/** BR-5 / E-12: Juniors and anyone under 18 never get alcohol; guests need an "ID verified 18+" tick first. */
async function assertAlcoholAllowed(tx: Tx, tab: { memberId: string | null; guestId: string | null; guestIdVerified: boolean }, itemName: string) {
  const today = istDate(clock.now());
  if (tab.memberId) {
    const m = await tx.member.findUniqueOrThrow({ where: { id: tab.memberId } });
    const age = ageOn(fromDbDate(m.dob), today);
    const ent = await entitlementsFor(tx, { memberId: m.id }, today);
    if (ent.tier === "JUNIOR" || age < 18) {
      throw new DomainError(
        "ALCOHOL_NOT_ALLOWED",
        `${itemName} can't be served: ${m.name} is ${ent.tier === "JUNIOR" ? "a Junior member" : "under 18"} (age ${age}).`,
        { age, tier: ent.tier },
      );
    }
    if (!ent.alcoholAllowed && ent.tier !== "WALK_IN") throw new DomainError("ALCOHOL_NOT_ALLOWED", `${m.name}'s plan does not allow alcohol.`);
    return;
  }
  if (!tab.guestIdVerified) {
    throw new DomainError("ALCOHOL_NOT_ALLOWED", `${itemName} can't be served yet: tick "ID verified 18+" for this guest first.`);
  }
}

export const addLinesSchema = z.object({
  items: z.array(z.object({ menuItemId: z.string().min(1), qty: z.number().int().positive().max(50), note: z.string().max(120).optional() })).min(1).max(40),
});

/** BR-4: items priced through the pricing engine with the payer's bar discount; each line belongs to the tab (R-26). */
export async function addLines(actor: Actor, tabId: string, raw: z.infer<typeof addLinesSchema>, outer?: Tx) {
  assertCan(actor, "bar.operate");
  const input = addLinesSchema.parse(raw);
  return withTx(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.status !== "OPEN") throw new DomainError("ORDER_STATE_INVALID", `Tab ${tab.code} is ${tab.status.toLowerCase()}; open a new tab to order.`);
    const menu = await tx.menuItem.findMany({ where: { id: { in: input.items.map((i) => i.menuItemId) } } });
    for (const i of input.items) {
      const m = menu.find((x) => x.id === i.menuItemId);
      if (!m || m.archivedAt) throw new DomainError("NOT_FOUND", "A menu item was not found.");
      if (!m.available) throw new DomainError("VALIDATION_FAILED", `${m.name} is sold out.`);
      if (m.isAlcoholic) await assertAlcoholAllowed(tx, tab, m.name);
    }
    const quote = await quoteBar(tx, {
      memberId: tab.memberId,
      date: istDate(clock.now()),
      items: input.items.map((i) => {
        const m = menu.find((x) => x.id === i.menuItemId)!;
        return { menuItemId: m.id, qty: i.qty, name: m.name, price: m.price, taxCategory: m.taxCategory, hsnSac: m.hsnSac, note: i.note };
      }),
    });
    const billLineIds = await addBillLines(tx, tab.billId, quote.lines);
    const created = [];
    for (const [idx, l] of quote.lines.entries()) {
      const line = await tx.tabLine.create({
        data: {
          tabId: tab.id, menuItemId: l.menuItemId!, billLineId: billLineIds[idx], qty: l.qty, unitPrice: l.unitPrice,
          discountPct: l.discountPct, discountAmount: l.discountAmount, netAmount: l.netAmount, note: input.items[idx].note ?? null,
          addedBy: actorId(actor) ?? "system",
        },
      });
      created.push({ id: line.id, name: l.description, qty: l.qty, netAmount: l.netAmount, discountPct: l.discountPct, explanation: l.explanation });
    }
    const bill = await refreshBill(tx, tab.billId);
    await audit(tx, actor, "tab.add_lines", "tab", tab.id, { after: { lines: created.map((c) => `${c.qty}× ${c.name}`), total: bill.total } });
    return { tabId: tab.id, lines: created, total: bill.total, due: billDue(bill) };
  }, outer);
}

export async function verifyGuestId(actor: Actor, tabId: string) {
  assertCan(actor, "bar.operate");
  return withTx(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (!tab.guestId) throw new DomainError("VALIDATION_FAILED", "ID verification is for guest tabs; members' ages come from their date of birth.");
    await tx.tab.update({ where: { id: tab.id }, data: { guestIdVerified: true } });
    await tx.guest.update({ where: { id: tab.guestId }, data: { idVerifiedAt: clock.now() } });
    await audit(tx, actor, "tab.guest_id_verified", "tab", tab.id, { after: { guestIdVerified: true } });
    return { tabId: tab.id, guestIdVerified: true };
  });
}

export async function moveTab(actor: Actor, tabId: string, tableId: string | null) {
  assertCan(actor, "bar.operate");
  return withTx(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.status !== "OPEN") throw new DomainError("ORDER_STATE_INVALID", "Only open tabs can change tables.");
    if (tableId && !(await tx.barTable.findUnique({ where: { id: tableId } }))) throw new DomainError("NOT_FOUND", "Table was not found.");
    await tx.tab.update({ where: { id: tab.id }, data: { tableId } });
    await audit(tx, actor, "tab.move", "tab", tab.id, { before: { tableId: tab.tableId }, after: { tableId } });
    return { tabId: tab.id, tableId };
  });
}

// ───────────── kitchen (BR-6, E-11) ─────────────

/** "Send to kitchen": the tab's unsent lines become one kitchen ticket. */
export async function sendToKitchen(actor: Actor, tabId: string, outer?: Tx) {
  assertCan(actor, "bar.operate");
  return withTx(async (tx) => {
    const tab = await lockTab(tx, tabId);
    const lines = await tx.tabLine.findMany({ where: { tabId: tab.id, kitchenTicketId: null, status: "NEW" } });
    if (!lines.length) throw new DomainError("VALIDATION_FAILED", "There are no new items to send.");
    const ticket = await tx.kitchenTicket.create({ data: { tabId: tab.id, tableId: tab.tableId, sentAt: clock.now(), sentBy: actorId(actor) ?? "system" } });
    await tx.tabLine.updateMany({ where: { id: { in: lines.map((l) => l.id) } }, data: { kitchenTicketId: ticket.id } });
    await audit(tx, actor, "kitchen.send", "kitchen_ticket", ticket.id, { after: { tab: tab.code, lines: lines.length } });
    return { ticketId: ticket.id, lines: lines.length };
  }, outer);
}

const LINE_NEXT: Partial<Record<TabLineStatus, TabLineStatus>> = { NEW: "PREPARING", PREPARING: "READY", READY: "SERVED" };

export async function setLineStatus(actor: Actor, lineId: string, status: "PREPARING" | "READY" | "SERVED", outer?: Tx) {
  assertCan(actor, status === "SERVED" ? "bar.operate" : "bar.kds");
  return withTx(async (tx) => {
    const line = await tx.tabLine.findUnique({ where: { id: lineId } });
    if (!line) throw new DomainError("NOT_FOUND", "Item was not found.");
    if (!line.kitchenTicketId) throw new DomainError("ORDER_STATE_INVALID", "Send this item to the kitchen first.");
    if (LINE_NEXT[line.status] !== status) throw new DomainError("ORDER_STATE_INVALID", `This item is ${line.status.toLowerCase()}; it can't become ${status.toLowerCase()}.`);
    const now = clock.now();
    await tx.tabLine.update({
      where: { id: line.id },
      data: { status, preparingAt: status === "PREPARING" ? now : undefined, readyAt: status === "READY" ? now : undefined, servedAt: status === "SERVED" ? now : undefined },
    });
    await audit(tx, actor, `kitchen.${status.toLowerCase()}`, "tab_line", line.id, { before: { status: line.status }, after: { status } });
    return { lineId: line.id, status };
  }, outer);
}

/** BR-7: before PREPARING any bar staff may void; after that only a Manager, with a reason (audited). */
export async function voidLine(actor: Actor, lineId: string, reason: string) {
  assertCan(actor, "bar.operate");
  return withTx(async (tx) => {
    const line = await tx.tabLine.findUnique({ where: { id: lineId }, include: { tab: true } });
    if (!line) throw new DomainError("NOT_FOUND", "Item was not found.");
    await lockTab(tx, line.tabId);
    if (line.status === "VOID") throw new DomainError("ORDER_STATE_INVALID", "This item is already void.");
    if (line.tab.status === "SETTLED" || line.tab.status === "VOID") throw new DomainError("ORDER_STATE_INVALID", `Tab ${line.tab.code} is ${line.tab.status.toLowerCase()}.`);
    const afterPrep = line.status !== "NEW";
    if (afterPrep && !can(actor, "bar.void_after_prep")) {
      throw new DomainError("FORBIDDEN", "Not allowed: this item is already being prepared — a manager must void it, with a reason.");
    }
    if ((afterPrep || reason) && reason.trim().length < 3) throw new DomainError("VALIDATION_FAILED", "A reason is required to void an item that is being prepared.");
    const now = clock.now();
    await tx.tabLine.update({ where: { id: line.id }, data: { status: "VOID", voidedBy: actorId(actor), voidReason: reason || null, voidedAt: now } });
    await voidBillLines(tx, [line.billLineId], now);
    // If the tab was partly paid and is now overpaid, the difference goes back.
    const totals = await tx.$queryRaw<{ total: number }[]>`SELECT coalesce(sum(net_amount),0)::int AS total FROM bill_lines WHERE bill_id = ${line.tab.billId} AND voided_at IS NULL`;
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: line.tab.billId } });
    const over = netPaid(bill) - totals[0].total;
    if (over > 0) await refundTx(tx, actor, bill.id, over, { reason: `Item voided on ${line.tab.code}` });
    const after = await refreshBill(tx, line.tab.billId);
    await audit(tx, actor, "tab.void_line", "tab_line", line.id, { before: { status: line.status, netAmount: line.netAmount }, after: { status: "VOID" }, reason });
    return { lineId: line.id, total: after.total, due: billDue(after) };
  });
}

// ───────────── settle / carry (BR-8, BR-9, E-13, E-14) ─────────────

export const settleSchema = z.object({
  payments: z.array(z.object({
    method: z.enum(["CASH", "CARD", "UPI"]),
    amount: z.number().int().positive(),
    reference: z.string().max(100).optional(),
    tendered: z.number().int().positive().optional(),
  })).min(1).max(4),
});

/** BR-8: one or more payments (split allowed). SETTLED only when paid = total; otherwise the tab stays OPEN. */
export async function settleTab(actor: Actor, tabId: string, raw: z.infer<typeof settleSchema>, idempotencyKey?: string | null) {
  assertCan(actor, "bar.operate");
  const input = settleSchema.parse(raw);
  return withTx((tx) =>
    idempotent(tx, { key: idempotencyKey, actorKey: actorKey(actor), endpoint: "bar.settle", body: { tabId, ...input } }, async () => {
      const tab = await lockTab(tx, tabId);
      if (tab.status !== "OPEN" && tab.status !== "CARRIED") throw new DomainError("ORDER_STATE_INVALID", `Tab ${tab.code} is already ${tab.status.toLowerCase()}.`);
      const r = await recordSplitPaymentsTx(tx, actor, tab.billId, input.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference ?? null, tendered: p.tendered ?? null })));
      const due = billDue(r.bill);
      if (due === 0) {
        await tx.tab.update({ where: { id: tab.id }, data: { status: "SETTLED", settledAt: clock.now() } });
        await audit(tx, actor, "tab.settle", "tab", tab.id, { before: { status: tab.status }, after: { status: "SETTLED", total: r.bill.total } });
      }
      return { tabId: tab.id, status: due === 0 ? "SETTLED" : tab.status, total: r.bill.total, paid: netPaid(r.bill), due, changeGiven: r.changeGiven };
    }),
  );
}

/** Settle after an online/other payment brought the balance to zero, or close a ₹0 tab. TAB_HAS_BALANCE otherwise. */
export async function closeTab(actor: Actor, tabId: string) {
  assertCan(actor, "bar.operate");
  return withTx(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.status !== "OPEN" && tab.status !== "CARRIED") throw new DomainError("ORDER_STATE_INVALID", `Tab ${tab.code} is already ${tab.status.toLowerCase()}.`);
    const bill = await refreshBill(tx, tab.billId);
    const due = billDue(bill);
    if (due > 0) throw new DomainError("TAB_HAS_BALANCE", `Tab ${tab.code} still has ${formatINR(due)} to pay.`, { due });
    const lines = await tx.tabLine.count({ where: { tabId: tab.id, status: { not: "VOID" } } });
    const status = lines === 0 && bill.total === 0 ? "VOID" : "SETTLED";
    await tx.tab.update({ where: { id: tab.id }, data: { status, settledAt: clock.now() } });
    await audit(tx, actor, status === "VOID" ? "tab.void" : "tab.settle", "tab", tab.id, { before: { status: tab.status }, after: { status } });
    return { tabId: tab.id, status };
  });
}

/** BR-9: a Manager may carry an open tab over (with a reason) so the bar day can be closed. */
export async function carryTab(actor: Actor, tabId: string, reason: string) {
  assertCan(actor, "bar.close_day");
  if (reason.trim().length < 3) throw new DomainError("VALIDATION_FAILED", "A reason is required to carry a tab over.");
  return withTx(async (tx) => {
    const tab = await lockTab(tx, tabId);
    if (tab.status !== "OPEN") throw new DomainError("ORDER_STATE_INVALID", `Only open tabs can be carried over (${tab.code} is ${tab.status.toLowerCase()}).`);
    await tx.tab.update({ where: { id: tab.id }, data: { status: "CARRIED", carriedReason: reason, carriedBy: actorId(actor) } });
    await audit(tx, actor, "tab.carry", "tab", tab.id, { before: { status: "OPEN" }, after: { status: "CARRIED" }, reason });
    return { tabId: tab.id, status: "CARRIED" as const };
  });
}

// ───────────── bar day (BR-9, BR-11, R-33) ─────────────

/** BR-11: revenue by method, by category, by staff/shift; discounts; voids; open/carried tabs. */
export async function barDayReport(actor: Actor, date: string) {
  assertCan(actor, "bar.report");
  if (!isValidDateStr(date)) throw new DomainError("VALIDATION_FAILED", "date must be YYYY-MM-DD");
  return computeBarDay(prisma, date);
}

async function computeBarDay(db: Tx | typeof prisma, date: string) {
  const [from, to] = istDayRange(date);
  const ledger = await db.ledgerEntry.findMany({ where: { source: "BAR", occurredAt: { gte: from, lt: to } } });
  const byMethod: Record<string, number> = { CASH: 0, CARD: 0, UPI: 0, ONLINE: 0 };
  for (const l of ledger) byMethod[l.method] += l.amount;
  const collected = ledger.reduce((a, l) => a + l.amount, 0);
  const payments = await db.payment.findMany({
    where: { bill: { sourceType: "BAR_TAB" }, status: "SUCCEEDED", occurredAt: { gte: from, lt: to } },
  });
  const staffIds = [...new Set(payments.map((p) => p.receivedBy).filter((x): x is string => !!x))];
  const users = await db.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } });
  const byStaff = staffIds.map((id) => ({
    userId: id,
    name: users.find((u) => u.id === id)?.name ?? "?",
    amount: payments.filter((p) => p.receivedBy === id).reduce((a, p) => a + (p.type === "PAYMENT" ? p.amount : -p.amount), 0),
    shifts: [...new Set(payments.filter((p) => p.receivedBy === id).map((p) => p.shiftId).filter(Boolean))].length,
  }));
  const tabs = await db.tab.findMany({ where: { barDate: dbDate(date) }, include: { lines: true } });
  const menu = await db.menuItem.findMany({ where: { id: { in: tabs.flatMap((t) => t.lines.map((l) => l.menuItemId)) } } });
  const byCategory: Record<MenuCategory, number> = { FOOD: 0, BEVERAGE: 0, ALCOHOL: 0 };
  let discounts = 0;
  let voidCount = 0;
  let voidAmount = 0;
  for (const t of tabs) {
    for (const l of t.lines) {
      if (l.status === "VOID") {
        voidCount++;
        voidAmount += l.netAmount;
        continue;
      }
      const m = menu.find((x) => x.id === l.menuItemId);
      if (m) byCategory[m.category] += l.netAmount;
      discounts += l.discountAmount;
    }
  }
  const bills = await db.bill.findMany({ where: { id: { in: tabs.map((t) => t.billId) } } });
  const settled = tabs.filter((t) => t.status === "SETTLED");
  const settledTotal = settled.reduce((a, t) => a + (bills.find((b) => b.id === t.billId)?.total ?? 0), 0);
  const openTabs = await db.tab.findMany({ where: { status: "OPEN", barDate: { lte: dbDate(date) } } });
  const openBills = await db.bill.findMany({ where: { id: { in: openTabs.map((t) => t.billId) } } });
  const carried = tabs.filter((t) => t.status === "CARRIED");
  const closed = await db.barDay.findUnique({ where: { date: dbDate(date) } });
  return {
    date,
    collected,
    byMethod,
    byCategory,
    byStaff,
    discounts,
    voids: { count: voidCount, amount: voidAmount },
    tabsOpened: tabs.length,
    tabsSettled: settled.length,
    averageTab: settled.length ? Math.round(settledTotal / settled.length) : 0,
    openTabs: openTabs.map((t) => ({ id: t.id, code: t.code, due: billDue(openBills.find((b) => b.id === t.billId)!) })),
    carriedTabs: carried.map((t) => ({ id: t.id, code: t.code, reason: t.carriedReason })),
    closedAt: closed?.closedAt ?? null,
  };
}

/** BR-9: the day can only be closed when every open tab is settled or carried over by a Manager. */
export async function closeBarDay(actor: Actor, date: string) {
  assertCan(actor, "bar.close_day");
  if (!isValidDateStr(date)) throw new DomainError("VALIDATION_FAILED", "date must be YYYY-MM-DD");
  return withTx(async (tx) => {
    const exists = await tx.barDay.findUnique({ where: { date: dbDate(date) } });
    if (exists) throw new DomainError("ORDER_STATE_INVALID", `The bar day ${date} is already closed.`);
    const open = await tx.tab.findMany({ where: { status: "OPEN", barDate: { lte: dbDate(date) } } });
    if (open.length) {
      throw new DomainError(
        "TAB_HAS_BALANCE",
        `Can't close the bar day: ${open.length} tab${open.length > 1 ? "s are" : " is"} still open (${open.map((t) => t.code).join(", ")}). Settle them or carry them over with a reason.`,
        { open: open.map((t) => t.code) },
      );
    }
    const report = await computeBarDay(tx, date);
    const row = await tx.barDay.create({ data: { date: dbDate(date), closedAt: clock.now(), closedBy: actorId(actor) ?? "system", report: JSON.parse(JSON.stringify(report)) as Prisma.InputJsonValue } });
    await audit(tx, actor, "bar.close_day", "bar_day", row.id, { after: { date, collected: report.collected } });
    return { ...report, closedAt: row.closedAt };
  });
}

// ───────────── read side ─────────────

export async function getTab(actor: Actor, tabId: string) {
  const tab = await prisma.tab.findUnique({ where: { id: tabId }, include: { lines: { orderBy: { createdAt: "asc" } } } });
  if (!tab) throw new DomainError("NOT_FOUND", "Tab was not found.");
  if (!can(actor, "bar.operate")) {
    if (!(actor.kind === "USER" && actor.role === "MEMBER" && tab.memberId === actor.memberId)) throw new DomainError("FORBIDDEN", "Not allowed: this tab belongs to someone else.");
  }
  const [bill, menu, table] = await Promise.all([
    prisma.bill.findUniqueOrThrow({ where: { id: tab.billId } }),
    prisma.menuItem.findMany({ where: { id: { in: tab.lines.map((l) => l.menuItemId) } } }),
    tab.tableId ? prisma.barTable.findUnique({ where: { id: tab.tableId } }) : null,
  ]);
  const billLines = await prisma.billLine.findMany({ where: { id: { in: tab.lines.map((l) => l.billLineId) } } });
  return {
    id: tab.id, code: tab.code, status: tab.status, payer: await payerName(prisma, tab), memberId: tab.memberId, guestId: tab.guestId,
    tier: bill.tier, table: table ? { id: table.id, number: table.number } : null, guestIdVerified: tab.guestIdVerified,
    billId: tab.billId, total: bill.total, paid: netPaid(bill), due: billDue(bill), discountTotal: bill.discountTotal,
    carriedReason: tab.carriedReason, openedAt: tab.createdAt, barDate: fromDbDate(tab.barDate),
    lines: tab.lines.map((l) => {
      const m = menu.find((x) => x.id === l.menuItemId);
      return {
        id: l.id, name: m?.name ?? "?", category: m?.category ?? "FOOD", isAlcoholic: m?.isAlcoholic ?? false, qty: l.qty, unitPrice: l.unitPrice,
        discountPct: l.discountPct, discountAmount: l.discountAmount, netAmount: l.netAmount, note: l.note, status: l.status,
        sent: !!l.kitchenTicketId, voidReason: l.voidReason, explanation: billLines.find((b) => b.id === l.billLineId)?.explanation ?? "",
      };
    }),
  };
}

export async function listTables(actor: Actor) {
  assertCan(actor, "bar.operate");
  const [tables, open] = await Promise.all([
    prisma.barTable.findMany({ orderBy: { number: "asc" } }),
    prisma.tab.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" } }),
  ]);
  const bills = await prisma.bill.findMany({ where: { id: { in: open.map((t) => t.billId) } } });
  const names = await Promise.all(open.map((t) => payerName(prisma, t)));
  const tabRow = (t: (typeof open)[number], i: number) => {
    const b = bills.find((x) => x.id === t.billId)!;
    return { id: t.id, code: t.code, payer: names[i], tier: b.tier, total: b.total, due: billDue(b) };
  };
  return {
    // BR-2: a table is OCCUPIED when any OPEN tab is assigned to it.
    tables: tables.map((tb) => {
      const tabs = open.map((t, i) => ({ t, i })).filter(({ t }) => t.tableId === tb.id).map(({ t, i }) => tabRow(t, i));
      return { id: tb.id, number: tb.number, capacity: tb.capacity, area: tb.area, status: tabs.length ? "OCCUPIED" : "FREE", tabs };
    }),
    unassigned: open.map((t, i) => ({ t, i })).filter(({ t }) => !t.tableId).map(({ t, i }) => tabRow(t, i)),
  };
}

/** KDS: lines sent to the kitchen and not yet served, grouped by ticket, with table and tab name (R-26). */
export async function kitchenQueue(actor: Actor) {
  assertCan(actor, "bar.kds");
  const lines = await prisma.tabLine.findMany({
    where: { kitchenTicketId: { not: null }, status: { in: ["NEW", "PREPARING", "READY"] } },
    include: { tab: true },
    orderBy: { createdAt: "asc" },
  });
  const ticketIds = [...new Set(lines.map((l) => l.kitchenTicketId!))];
  const [tickets, menu, tables] = await Promise.all([
    prisma.kitchenTicket.findMany({ where: { id: { in: ticketIds } } }),
    prisma.menuItem.findMany({ where: { id: { in: lines.map((l) => l.menuItemId) } } }),
    prisma.barTable.findMany(),
  ]);
  const names = new Map<string, string>();
  for (const l of lines) if (!names.has(l.tabId)) names.set(l.tabId, await payerName(prisma, l.tab));
  const now = clock.now().getTime();
  return tickets
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    .map((t) => {
      const tab = lines.find((l) => l.kitchenTicketId === t.id)!.tab;
      const table = tables.find((x) => x.id === (tab.tableId ?? t.tableId));
      return {
        ticketId: t.id, sentAt: t.sentAt, ageMinutes: Math.floor((now - t.sentAt.getTime()) / MINUTE),
        table: table?.number ?? null, tabCode: tab.code, payer: names.get(tab.id)!,
        lines: lines.filter((l) => l.kitchenTicketId === t.id).map((l) => ({ id: l.id, name: menu.find((m) => m.id === l.menuItemId)?.name ?? "?", qty: l.qty, note: l.note, status: l.status })),
      };
    });
}

/** Waiter view: lines READY to serve. */
export async function readyQueue(actor: Actor) {
  assertCan(actor, "bar.operate");
  const lines = await prisma.tabLine.findMany({ where: { status: "READY" }, include: { tab: true }, orderBy: { readyAt: "asc" } });
  const [menu, tables] = await Promise.all([prisma.menuItem.findMany({ where: { id: { in: lines.map((l) => l.menuItemId) } } }), prisma.barTable.findMany()]);
  const out = [];
  for (const l of lines) {
    out.push({
      id: l.id, name: menu.find((m) => m.id === l.menuItemId)?.name ?? "?", qty: l.qty, note: l.note, readyAt: l.readyAt,
      table: tables.find((t) => t.id === l.tab.tableId)?.number ?? null, tabCode: l.tab.code, payer: await payerName(prisma, l.tab),
    });
  }
  return out;
}

export async function listOpenTabs(actor: Actor) {
  assertCan(actor, "bar.operate");
  const tabs = await prisma.tab.findMany({ where: { status: { in: ["OPEN", "CARRIED"] } }, orderBy: { createdAt: "asc" } });
  const bills = await prisma.bill.findMany({ where: { id: { in: tabs.map((t) => t.billId) } } });
  const out = [];
  for (const t of tabs) {
    const b = bills.find((x) => x.id === t.billId)!;
    out.push({ id: t.id, code: t.code, status: t.status, payer: await payerName(prisma, t), tier: b.tier, total: b.total, due: billDue(b), barDate: fromDbDate(t.barDate), carriedReason: t.carriedReason });
  }
  return out;
}

export async function myTabs(actor: Actor) {
  if (!(actor.kind === "USER" && actor.role === "MEMBER" && actor.memberId)) throw new DomainError("FORBIDDEN", "Members only.");
  const tabs = await prisma.tab.findMany({ where: { memberId: actor.memberId }, orderBy: { createdAt: "desc" }, take: 30 });
  return Promise.all(tabs.map((t) => getTab(actor, t.id)));
}

// ───────────── menu & tables (BR-1, BR-2) ─────────────

export async function listMenu(opts: { includeUnavailable?: boolean } = {}) {
  return prisma.menuItem.findMany({
    where: { archivedAt: null, available: opts.includeUnavailable ? undefined : true },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

export const menuItemSchema = z.object({
  name: z.string().trim().min(2).max(80),
  category: z.enum(["FOOD", "BEVERAGE", "ALCOHOL"]),
  price: z.number().int().min(0),
  isAlcoholic: z.boolean().optional(),
  hsnSac: z.string().trim().min(4).max(10).default("996331"),
  sortOrder: z.number().int().default(0),
});

export async function createMenuItem(actor: Actor, raw: z.input<typeof menuItemSchema>, outer?: Tx) {
  assertCan(actor, "bar.close_day"); // OWNER / MANAGER manage the menu
  const input = menuItemSchema.parse(raw);
  return withTx(async (tx) => {
    const alcoholic = input.isAlcoholic ?? input.category === "ALCOHOL";
    const item = await tx.menuItem.create({
      data: { name: input.name, category: input.category, price: input.price, isAlcoholic: alcoholic, taxCategory: alcoholic ? "ALCOHOL" : "RESTAURANT", hsnSac: input.hsnSac, sortOrder: input.sortOrder },
    });
    await audit(tx, actor, "menu.create", "menu_item", item.id, { after: item });
    return item;
  }, outer);
}

/** Bar staff can mark an item sold out / back on (BR-1). Price changes are Owner/Manager only. */
export async function updateMenuItem(actor: Actor, id: string, raw: { available?: boolean; price?: number }) {
  assertCan(actor, "bar.operate");
  if (raw.price !== undefined) assertCan(actor, "bar.close_day");
  return withTx(async (tx) => {
    const before = await tx.menuItem.findUnique({ where: { id } });
    if (!before) throw new DomainError("NOT_FOUND", "Menu item was not found.");
    const item = await tx.menuItem.update({ where: { id }, data: { available: raw.available, price: raw.price } });
    await audit(tx, actor, "menu.update", "menu_item", id, { before, after: item });
    return item;
  });
}

export async function createTable(actor: Actor, raw: { number: number; capacity: number; area: string }, outer?: Tx) {
  assertCan(actor, "bar.close_day");
  return withTx(async (tx) => {
    const t = await tx.barTable.create({ data: raw });
    await audit(tx, actor, "table.create", "bar_table", t.id, { after: t });
    return t;
  }, outer);
}
