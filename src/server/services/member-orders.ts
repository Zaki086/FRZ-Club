// v5 §1.2–1.3 (ORDER): members order from the portal "Bar & Café" onto their own bar tab (cash only: the tab is settled
// at the bar with the existing settle flow and drawer v2).
//  MO-1  Ordering needs a table QR scanned on this login in the last 3 hours, or an open check-in visit today.
//  MO-2  The order goes on the member's OPEN tab; none → one is opened (payer = member, table from the scan). BR-3 holds.
//  MO-3  It waits in the bar's "Incoming orders" until bar staff Accept (its lines become one kitchen ticket, exactly
//        like "Send to kitchen", BR-6) or Reject it with a reason (its lines are voided; the member is told).
//  MO-4  `auto_accept_member_orders`: an order placed with a valid table scan goes straight to the kitchen.
//  MO-5  `member_tab_limit`: an order that would take what the member owes on the bar above the limit is refused.
//  MO-6  Prices come from the pricing engine (the member's bar discount); alcohol for Juniors/under-18 is refused by
//        the same BR-5 check staff orders go through (ALCOHOL_NOT_ALLOWED) and hidden from their menu.
//  MO-8  A member may cancel a line only while their order waits for the bar (NEW, not accepted).
//  MO-9  Accepted, rejected (with the reason), ready ("Your order is ready") and tab settled: in-app + push.
//  MO-10 Lines keep `member_order_id`: "via app" on the tab and the kitchen display; staff lines are "by staff".
import type { Member, MemberOrder, Tab } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { CODE_SEQUENCE, formatCode } from "@/lib/codes";
import { formatINR } from "@/lib/money";
import { ageOn, dbDate, fromDbDate, HOUR, istDate, istDayRange, MINUTE } from "@/lib/time";
import { nextSeq, pgErrorCode, prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import { tokenHash } from "../auth/sessions";
import { actorId, actorKey, type Actor, type SystemActor, type UserActor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { addLines, sendToKitchen, voidLine } from "./bar";
import { billDue, createBill, netPaid, refreshBill, voidBillLines } from "./bills";
import { memberAudience, notifyMember, type NotifyEvent } from "./channels";
import { idempotent } from "./idempotency";
import { memberMenuView } from "./menu";
import { entitlementsFor, type Tier } from "./pricing";
import { getSettings } from "./settings";
import { verifyTableToken } from "./table-token";

/** MO-1: a table scan lets the member order for this long. */
export const TABLE_SCAN_HOURS = 3;
export const NOT_AT_CLUB_MESSAGE = "Ordering is available when you're at the club. Scan the QR on your table or check in at the front desk.";
export const TAB_LIMIT_MESSAGE = "Please settle your tab at the bar to continue ordering.";
export const SETTLE_REMINDER = "Settle at the bar before you leave";

export const REJECT_REASONS = ["ITEM_UNAVAILABLE", "MEMBER_NOT_FOUND", "OTHER"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export const REJECT_REASON_LABEL: Record<RejectReason, string> = {
  ITEM_UNAVAILABLE: "Item unavailable",
  MEMBER_NOT_FOUND: "Member not found at the table",
  OTHER: "Other",
};
/** What the member reads (notification and portal). */
const REJECT_REASON_TEXT: Record<RejectReason, string> = {
  ITEM_UNAVAILABLE: "an item you ordered is not available right now",
  MEMBER_NOT_FOUND: "the bar couldn't find you at your table",
  OTHER: "the bar couldn't take it",
};

/** MO-4: orders the club's setting accepts on its own are recorded as accepted by this system actor. */
const AUTO_ACCEPT: SystemActor = { kind: "SYSTEM", name: "auto-accept" };

type Db = Tx | typeof prisma;

// ───────────── who orders (a member, or a guardian for their Junior) ─────────────

function assertMemberActor(actor: Actor): asserts actor is UserActor & { memberId: string } {
  if (actor.kind !== "USER") throw new DomainError("UNAUTHENTICATED", "Please log in.");
  if (actor.role !== "MEMBER" || !actor.memberId) throw new DomainError("FORBIDDEN", "Not allowed: Bar & Café ordering is for members.");
}

/** The member the order is for: the actor, or a Junior / under-18 member whose guardian is the actor. */
async function orderFor(db: Db, actor: UserActor & { memberId: string }, forMemberId?: string | null): Promise<{ member: Member; onBehalf: boolean }> {
  if (!forMemberId || forMemberId === actor.memberId) return { member: await db.member.findUniqueOrThrow({ where: { id: actor.memberId } }), onBehalf: false };
  const junior = await db.member.findFirst({ where: { id: forMemberId, guardianMemberId: actor.memberId, anonymisedAt: null } });
  if (!junior) throw new DomainError("FORBIDDEN", "Not allowed: you can order only for yourself or a Junior in your family.");
  return { member: junior, onBehalf: true };
}

/** MO-6 / BR-5: the menu hides alcohol from Juniors, anyone under 18, and plans without alcohol. */
async function alcoholHidden(db: Db, member: Member, today: string): Promise<{ hidden: boolean; tier: Tier }> {
  const ent = await entitlementsFor(db, { memberId: member.id }, today);
  const age = ageOn(fromDbDate(member.dob), today);
  return { hidden: ent.tier === "JUNIOR" || age < 18 || (!ent.alcoholAllowed && ent.tier !== "WALK_IN"), tier: ent.tier };
}

// ───────────── MO-1: where the member is ─────────────

export type Presence = {
  atClub: boolean;
  via: "TABLE" | "CHECKIN" | null;
  table: { id: string; number: number; area: string } | null;
  scanValidUntil: string | null;
};

/**
 * MO-1: (a) a table QR scanned on this login within TABLE_SCAN_HOURS (the stored token is checked again), or (b) an
 * open check-in visit today (checked in, not checked out) of the member or the Junior they order for.
 */
export async function presenceOf(db: Db, actor: UserActor, sessionToken: string | null | undefined, memberIds: string[]): Promise<Presence> {
  const now = clock.now();
  if (sessionToken) {
    const s = await db.session.findUnique({ where: { tokenHash: tokenHash(sessionToken) } });
    if (s && s.userId === actor.userId && s.tableId && s.tableScannedAt && s.tableToken && verifyTableToken(s.tableToken)?.tableId === s.tableId) {
      const until = s.tableScannedAt.getTime() + TABLE_SCAN_HOURS * HOUR;
      if (now.getTime() <= until) {
        const table = await db.barTable.findUnique({ where: { id: s.tableId } });
        if (table) return { atClub: true, via: "TABLE", table: { id: table.id, number: table.number, area: table.area }, scanValidUntil: new Date(until).toISOString() };
      }
    }
  }
  const [from, to] = istDayRange(istDate(now));
  const visit = await db.visit.findFirst({ where: { memberId: { in: memberIds }, checkedOutAt: null, checkedInAt: { gte: from, lt: to } } });
  if (visit) return { atClub: true, via: "CHECKIN", table: null, scanValidUntil: null };
  return { atClub: false, via: null, table: null, scanValidUntil: null };
}

/**
 * The `/t/<token>` table QR: verify the TBL1 token and remember the table on this login (MO-1). A forged or altered
 * token → LINK_INVALID (the page shows an error); a table that no longer exists likewise.
 */
export async function recordTableScan(actor: Actor, sessionToken: string | null | undefined, rawToken: string) {
  if (actor.kind !== "USER" || !sessionToken) throw new DomainError("UNAUTHENTICATED", "Please log in.");
  if (actor.role !== "MEMBER") throw new DomainError("FORBIDDEN", "Table QR codes are for members ordering from the Bar & Café. Staff take orders on the bar screen.");
  const token = String(rawToken ?? "").trim();
  const v = verifyTableToken(token);
  const table = v ? await prisma.barTable.findUnique({ where: { id: v.tableId } }) : null;
  if (!v || !table) throw new DomainError("LINK_INVALID", "This table QR code is not valid. Please scan the code on your table again, or ask the bar staff.");
  const now = clock.now();
  return withTx(async (tx) => {
    const r = await tx.session.updateMany({ where: { tokenHash: tokenHash(sessionToken), userId: actor.userId }, data: { tableId: table.id, tableToken: token, tableScannedAt: now } });
    if (!r.count) throw new DomainError("UNAUTHENTICATED", "Your session has ended. Please log in again.");
    await audit(tx, actor, "bar.table_scan", "bar_table", table.id, { after: { table: table.number, validUntil: new Date(now.getTime() + TABLE_SCAN_HOURS * HOUR).toISOString() } });
    return { table: { id: table.id, number: table.number, area: table.area }, validUntil: new Date(now.getTime() + TABLE_SCAN_HOURS * HOUR).toISOString() };
  });
}

// ───────────── §1.2 the menu members see ─────────────

/**
 * The menu as this member sees it (MenuView shape): ACTIVE + available items of active categories, each with the
 * member's own price from the pricing engine and its explanation. Alcohol is left out for Juniors / under-18 (MO-6),
 * also when a guardian browses for their Junior.
 */
export async function memberMenu(actor: Actor, opts: { forMemberId?: string | null } = {}) {
  assertMemberActor(actor);
  const { member } = await orderFor(prisma, actor, opts.forMemberId);
  return menuFor(prisma, member);
}

/** The member menu for one member: MENU's `memberMenuView` (the same view as "Preview as member"), alcohol hidden per MO-6. */
async function menuFor(db: Db, member: Member) {
  const { hidden, tier } = await alcoholHidden(db, member, istDate(clock.now()));
  const categories = await memberMenuView(db, { memberId: member.id, hideAlcohol: hidden });
  return { categories, tier, alcoholHidden: hidden, member: { id: member.id, name: member.name } };
}

// ───────────── MO-2: placing an order ─────────────

export const memberOrderSchema = z.object({
  forMemberId: z.string().min(1).optional().nullable(),
  items: z
    .array(z.object({ menuItemId: z.string().min(1), qty: z.number().int().positive().max(20), note: z.string().trim().max(120).optional() }))
    .min(1)
    .max(30),
});

/** MO-2: open the member's tab from the app (payer = the member, table from the scan). BR-3: one OPEN tab each. */
async function openMemberTabTx(tx: Tx, actor: UserActor, member: Member, tableId: string | null): Promise<Tab> {
  const today = istDate(clock.now());
  const ent = await entitlementsFor(tx, { memberId: member.id }, today);
  const code = formatCode("tab", await nextSeq(tx, CODE_SEQUENCE.tab));
  const bill = await createBill(tx, { sourceType: "BAR_TAB", customer: { memberId: member.id, name: member.name }, tier: ent.tier, lines: [], createdBy: actorId(actor) });
  let tab: Tab;
  try {
    tab = await tx.tab.create({ data: { code, memberId: member.id, tableId, openedBy: actor.userId, billId: bill.id, barDate: dbDate(today) } });
  } catch (e) {
    if (pgErrorCode(e) === "23505") throw new DomainError("TAB_ALREADY_OPEN", "Your tab was opened a moment ago — please send the order again.");
    throw e;
  }
  await tx.bill.update({ where: { id: bill.id }, data: { sourceId: tab.id } });
  await audit(tx, actor, "tab.open", "tab", tab.id, { after: { code, payer: member.name, tier: ent.tier, tableId, via: "app" } });
  return tab;
}

/** What the member still owes the bar: the open tab and any tab carried over unpaid (MO-5). */
async function owedAtBar(tx: Tx, memberId: string): Promise<number> {
  const tabs = await tx.tab.findMany({ where: { memberId, status: { in: ["OPEN", "CARRIED"] } }, select: { billId: true } });
  const bills = await tx.bill.findMany({ where: { id: { in: tabs.map((t) => t.billId) } } });
  return bills.reduce((a, b) => a + billDue(b), 0);
}

/**
 * MO-1…MO-6: place an order from the portal. `sessionToken` is the caller's login (its table scan, MO-1). With an
 * Idempotency-Key a resent order is placed once.
 */
export async function placeMemberOrder(actor: Actor, raw: z.input<typeof memberOrderSchema>, ctx: { sessionToken?: string | null; idempotencyKey?: string | null } = {}) {
  assertMemberActor(actor);
  const input = memberOrderSchema.parse(raw);
  return withTx((tx) =>
    idempotent(tx, { key: ctx.idempotencyKey, actorKey: actorKey(actor), endpoint: "bar.member_order", body: input }, async () => {
      const { member, onBehalf } = await orderFor(tx, actor, input.forMemberId);
      const where = await presenceOf(tx, actor, ctx.sessionToken, [...new Set([member.id, actor.memberId])]);
      if (!where.atClub) throw new DomainError("NOT_AT_CLUB", NOT_AT_CLUB_MESSAGE);
      const s = await getSettings(tx);
      let tab = await tx.tab.findFirst({ where: { memberId: member.id, status: "OPEN" } });
      if (!tab) tab = await openMemberTabTx(tx, actor, member, where.table?.id ?? null);
      else if (!tab.tableId && where.table) {
        // The tab was at the counter; the member has now sat down at a table.
        tab = await tx.tab.update({ where: { id: tab.id }, data: { tableId: where.table.id } });
        await audit(tx, actor, "tab.move", "tab", tab.id, { before: { tableId: null }, after: { tableId: where.table.id }, reason: "Table QR scanned" });
      }
      const order = await tx.memberOrder.create({
        data: { tabId: tab.id, memberId: member.id, placedBy: actor.userId, tableId: where.table?.id ?? tab.tableId, viaTableScan: where.via === "TABLE", total: 0 },
      });
      // Priced by the pricing engine and checked like any staff line (availability, BR-5 alcohol) — MO-6.
      const added = await addLines(actor, tab.id, { items: input.items.map((i) => ({ menuItemId: i.menuItemId, qty: i.qty, note: i.note || undefined })) }, tx, { memberOrderId: order.id });
      const total = added.lines.reduce((a, l) => a + l.netAmount, 0);
      const owed = await owedAtBar(tx, member.id);
      if (owed > s.member_tab_limit) {
        throw new DomainError("TAB_LIMIT_REACHED", TAB_LIMIT_MESSAGE, { limit: s.member_tab_limit, owedBefore: owed - total, order: total });
      }
      await tx.memberOrder.update({ where: { id: order.id }, data: { total } });
      await audit(tx, actor, "member_order.place", "member_order", order.id, {
        after: { tab: tab.code, member: member.name, onBehalf, via: where.via, table: where.table?.number ?? null, lines: added.lines.map((l) => `${l.qty}× ${l.name}`), total },
      });
      let status: "PENDING" | "ACCEPTED" = "PENDING";
      if (s.auto_accept_member_orders && where.via === "TABLE") {
        await acceptTx(tx, AUTO_ACCEPT, order.id, undefined);
        status = "ACCEPTED";
      }
      return { orderId: order.id, status, tabId: tab.id, tabCode: tab.code, total, tabTotal: added.total, due: added.due, table: where.table?.number ?? null };
    }),
  );
}

// ───────────── MO-3 / MO-4: the bar accepts or rejects ─────────────

async function lockOrder(tx: Tx, orderId: string): Promise<MemberOrder> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM member_orders WHERE id = ${orderId} FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", "Order was not found.");
  return tx.memberOrder.findUniqueOrThrow({ where: { id: orderId } });
}

function lineSummary(lines: Array<{ qty: number; name: string }>): string {
  return lines.map((l) => `${l.qty}× ${l.name}`).join(", ");
}

async function orderLines(db: Db, orderId: string) {
  const lines = await db.tabLine.findMany({ where: { memberOrderId: orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const menu = await db.menuItem.findMany({ where: { id: { in: lines.map((l) => l.menuItemId) } }, select: { id: true, name: true, isAlcoholic: true } });
  return lines.map((l) => ({ ...l, name: menu.find((m) => m.id === l.menuItemId)?.name ?? "?", isAlcoholic: menu.find((m) => m.id === l.menuItemId)?.isAlcoholic ?? false }));
}

/** MO-9: tell the member (and a Junior's guardian) on the bell + push. Bar messages are never held for quiet hours. */
async function tellMember(tx: Tx, memberId: string, m: { event: NotifyEvent; title: string; body: string; link: string; key: string; urgent: boolean }, actor: Actor) {
  for (const a of await memberAudience(tx, [memberId])) {
    await notifyMember(tx, { event: m.event, userId: a.userId, memberId, title: m.title, body: m.body, link: m.link, dedupeKey: `${m.key}:${a.userId}`, channels: ["PUSH"], urgent: m.urgent, actor });
  }
}

async function acceptTx(tx: Tx, actor: Actor, orderId: string, tableId: string | null | undefined) {
  const order = await lockOrder(tx, orderId);
  if (order.status !== "PENDING") throw new DomainError("ORDER_STATE_INVALID", `This order was already ${order.status.toLowerCase()}.`);
  const tab = await tx.tab.findUniqueOrThrow({ where: { id: order.tabId } });
  if (tab.status !== "OPEN") throw new DomainError("ORDER_STATE_INVALID", `Tab ${tab.code} is ${tab.status.toLowerCase()}.`);
  let table = tab.tableId;
  if (tableId !== undefined && tableId !== tab.tableId) {
    if (tableId && !(await tx.barTable.findUnique({ where: { id: tableId } }))) throw new DomainError("NOT_FOUND", "Table was not found.");
    await tx.tab.update({ where: { id: tab.id }, data: { tableId } });
    await audit(tx, actor, "tab.move", "tab", tab.id, { before: { tableId: tab.tableId }, after: { tableId }, reason: "Set when accepting an app order" });
    table = tableId;
  }
  const live = (await orderLines(tx, order.id)).filter((l) => l.status === "NEW" && !l.kitchenTicketId);
  if (!live.length) throw new DomainError("VALIDATION_FAILED", "Every item of this order was removed — reject it instead.");
  // BR-6: exactly like "Send to kitchen" — one kitchen ticket with this order's lines.
  const sent = await sendToKitchen(actor, tab.id, tx, { memberOrderId: order.id });
  const now = clock.now();
  await tx.memberOrder.update({
    where: { id: order.id },
    data: { status: "ACCEPTED", decidedBy: actorId(actor), decidedAt: now, kitchenTicketId: sent.ticketId, autoAccepted: actor.kind === "SYSTEM", tableId: table },
  });
  await audit(tx, actor, "member_order.accept", "member_order", order.id, { before: { status: "PENDING" }, after: { status: "ACCEPTED", ticketId: sent.ticketId, tableId: table, auto: actor.kind === "SYSTEM" } });
  const tableRow = table ? await tx.barTable.findUnique({ where: { id: table } }) : null;
  await tellMember(tx, order.memberId, {
    event: "BAR_ORDER_ACCEPTED",
    title: "Order accepted",
    body: `${lineSummary(live)} — with the kitchen now${tableRow ? `, for table ${tableRow.number}` : ""}.`,
    link: "/portal/bar",
    key: `bar-order-accepted:${order.id}`,
    urgent: true,
  }, actor);
  return { orderId: order.id, status: "ACCEPTED" as const, ticketId: sent.ticketId, lines: sent.lines };
}

export const acceptOrderSchema = z.object({ tableId: z.string().min(1).nullable().optional() });

/** MO-3: Accept (optionally set or confirm the table) → the order's lines go to the kitchen. */
export async function acceptMemberOrder(actor: Actor, orderId: string, raw: z.input<typeof acceptOrderSchema> = {}) {
  assertCan(actor, "bar.operate");
  const input = acceptOrderSchema.parse(raw ?? {});
  return withTx((tx) => acceptTx(tx, actor, orderId, input.tableId));
}

export const rejectOrderSchema = z
  .object({ reason: z.enum(REJECT_REASONS), note: z.string().trim().max(200).optional() })
  .refine((v) => v.reason !== "OTHER" || (v.note ?? "").length >= 3, { message: "Say why the order can't be taken.", path: ["note"] });

/** A tab the app opened that now holds nothing (its only order rejected or cancelled) is closed as void. */
async function voidEmptyAppTab(tx: Tx, actor: Actor, order: MemberOrder) {
  const tab = await tx.tab.findUniqueOrThrow({ where: { id: order.tabId } });
  if (tab.status !== "OPEN" || tab.openedBy !== order.placedBy) return;
  const live = await tx.tabLine.count({ where: { tabId: tab.id, status: { not: "VOID" } } });
  const bill = await refreshBill(tx, tab.billId);
  if (live > 0 || bill.total !== 0 || netPaid(bill) !== 0) return;
  await tx.tab.update({ where: { id: tab.id }, data: { status: "VOID", settledAt: clock.now() } });
  await audit(tx, actor, "tab.void", "tab", tab.id, { before: { status: "OPEN" }, after: { status: "VOID" }, reason: "Opened by an app order that was not taken" });
}

/** MO-3: Reject with a reason → the order's lines are voided and the member is told why. */
export async function rejectMemberOrder(actor: Actor, orderId: string, raw: z.input<typeof rejectOrderSchema>) {
  assertCan(actor, "bar.operate");
  const input = rejectOrderSchema.parse(raw);
  return withTx(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status !== "PENDING") throw new DomainError("ORDER_STATE_INVALID", `This order was already ${order.status.toLowerCase()}.`);
    const reasonText = input.reason === "OTHER" ? input.note! : REJECT_REASON_LABEL[input.reason] + (input.note ? ` — ${input.note}` : "");
    const lines = (await orderLines(tx, order.id)).filter((l) => l.status === "NEW" && !l.kitchenTicketId);
    // Existing void rules (BR-7): NEW lines may be voided by bar staff; an overpaid tab gets the difference back.
    for (const l of lines) await voidLine(actor, l.id, `App order rejected: ${reasonText}`, tx);
    await tx.memberOrder.update({ where: { id: order.id }, data: { status: "REJECTED", decidedBy: actorId(actor), decidedAt: clock.now(), rejectReason: input.reason, rejectNote: input.note ?? null } });
    await audit(tx, actor, "member_order.reject", "member_order", order.id, { before: { status: "PENDING" }, after: { status: "REJECTED", reason: input.reason }, reason: reasonText });
    await voidEmptyAppTab(tx, actor, order);
    const why = input.reason === "OTHER" ? input.note! : REJECT_REASON_TEXT[input.reason] + (input.note ? ` (${input.note})` : "");
    await tellMember(tx, order.memberId, {
      event: "BAR_ORDER_REJECTED",
      title: "Order not accepted",
      body: `Sorry — ${lines.length ? lineSummary(lines) : "your order"} could not be taken: ${why}. Nothing was charged for it.`,
      link: "/portal/bar",
      key: `bar-order-rejected:${order.id}`,
      urgent: true,
    }, actor);
    return { orderId: order.id, status: "REJECTED" as const, voided: lines.length };
  });
}

// ───────────── MO-8: the member cancels a line ─────────────

/** MO-8: a member removes a line while their order still waits for the bar. Afterwards only bar staff can void it. */
export async function cancelMemberLine(actor: Actor, lineId: string) {
  assertMemberActor(actor);
  return withTx(async (tx) => {
    const first = await tx.tabLine.findUnique({ where: { id: lineId } });
    if (!first || !first.memberOrderId) throw new DomainError("NOT_FOUND", "Item was not found.");
    const order = await lockOrder(tx, first.memberOrderId);
    await orderFor(tx, actor, order.memberId); // own order, or one for their Junior
    await tx.$queryRaw`SELECT id FROM tabs WHERE id = ${order.tabId} FOR UPDATE`;
    const line = await tx.tabLine.findUniqueOrThrow({ where: { id: lineId } });
    if (line.status === "VOID") throw new DomainError("ORDER_STATE_INVALID", "This item was already removed.");
    if (order.status !== "PENDING" || line.status !== "NEW" || line.kitchenTicketId) {
      throw new DomainError("ORDER_STATE_INVALID", "The bar has already accepted this item — ask the bar staff if you need to change it.");
    }
    const tab = await tx.tab.findUniqueOrThrow({ where: { id: order.tabId } });
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: tab.billId } });
    if (netPaid(bill) > bill.total - line.netAmount) throw new DomainError("ORDER_STATE_INVALID", "Part of this tab is already paid — ask the bar staff to remove the item.");
    const now = clock.now();
    await tx.tabLine.update({ where: { id: line.id }, data: { status: "VOID", voidedBy: actor.userId, voidReason: "Cancelled by the member in the app", voidedAt: now } });
    await voidBillLines(tx, [line.billLineId], now);
    const after = await refreshBill(tx, tab.billId);
    await audit(tx, actor, "tab.void_line", "tab_line", line.id, { before: { status: "NEW", netAmount: line.netAmount }, after: { status: "VOID" }, reason: "Cancelled by the member in the app" });
    const left = await tx.tabLine.count({ where: { memberOrderId: order.id, status: { not: "VOID" } } });
    let orderStatus = order.status;
    if (left === 0) {
      await tx.memberOrder.update({ where: { id: order.id }, data: { status: "CANCELLED", decidedBy: actor.userId, decidedAt: now } });
      await audit(tx, actor, "member_order.cancel", "member_order", order.id, { before: { status: "PENDING" }, after: { status: "CANCELLED" } });
      await voidEmptyAppTab(tx, actor, order);
      orderStatus = "CANCELLED";
    }
    return { lineId: line.id, orderStatus, total: after.total, due: billDue(after) };
  });
}

// ───────────── MO-9: ready and settled ─────────────

/** Called by setLineStatus when a line becomes READY: once every item of the order is ready, tell the member. */
export async function notifyOrderReadyTx(tx: Tx, orderId: string, actor: Actor) {
  const order = await tx.memberOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "ACCEPTED") return;
  const lines = (await orderLines(tx, order.id)).filter((l) => l.status !== "VOID");
  if (!lines.length || lines.some((l) => l.status !== "READY" && l.status !== "SERVED")) return;
  const tab = await tx.tab.findUniqueOrThrow({ where: { id: order.tabId } });
  const table = tab.tableId ? await tx.barTable.findUnique({ where: { id: tab.tableId } }) : null;
  await tellMember(tx, order.memberId, {
    event: "BAR_ORDER_READY",
    title: "Your order is ready",
    body: `${lineSummary(lines)} — ${table ? `coming to table ${table.number}` : "collect it at the bar"}.`,
    link: "/portal/bar",
    key: `bar-order-ready:${order.id}`,
    urgent: true,
  }, actor);
}

/** Called when a member's tab is settled (settle or close): the receipt on the bell + push. */
export async function notifyTabSettledTx(tx: Tx, tabId: string, actor: Actor) {
  const tab = await tx.tab.findUniqueOrThrow({ where: { id: tabId } });
  if (!tab.memberId) return;
  const bill = await tx.bill.findUniqueOrThrow({ where: { id: tab.billId } });
  await tellMember(tx, tab.memberId, {
    event: "BAR_TAB_SETTLED",
    title: "Bar tab settled",
    body: `Tab ${tab.code}: ${formatINR(bill.total)} paid${bill.discountTotal ? ` (you saved ${formatINR(bill.discountTotal)})` : ""}. Thank you!`,
    link: `/portal/receipts/${bill.id}`,
    key: `bar-tab-settled:${tab.id}`,
    urgent: false,
  }, actor);
}

// ───────────── read side ─────────────

/** MO-3: the bar's "Incoming orders" — every order waiting for Accept/Reject, oldest first, with its waiting time. */
export async function incomingOrders(actor: Actor) {
  assertCan(actor, "bar.operate");
  const s = await getSettings();
  const orders = await prisma.memberOrder.findMany({ where: { status: "PENDING" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const [lines, members, tabs, tables] = await Promise.all([
    prisma.tabLine.findMany({ where: { memberOrderId: { in: orders.map((o) => o.id) } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.member.findMany({ where: { id: { in: orders.map((o) => o.memberId) } }, select: { id: true, name: true, memberCode: true } }),
    prisma.tab.findMany({ where: { id: { in: orders.map((o) => o.tabId) } } }),
    prisma.barTable.findMany({ orderBy: { number: "asc" } }),
  ]);
  const [menu, bills] = await Promise.all([
    prisma.menuItem.findMany({ where: { id: { in: lines.map((l) => l.menuItemId) } }, select: { id: true, name: true, isAlcoholic: true, prepMinutes: true } }),
    prisma.bill.findMany({ where: { id: { in: tabs.map((t) => t.billId) } }, select: { id: true, tier: true } }),
  ]);
  const now = clock.now().getTime();
  return {
    acceptMinutes: s.member_order_accept_minutes,
    autoAccept: s.auto_accept_member_orders,
    tables: tables.map((t) => ({ id: t.id, number: t.number, area: t.area })),
    orders: orders.map((o) => {
      const tab = tabs.find((t) => t.id === o.tabId)!;
      const m = members.find((x) => x.id === o.memberId);
      const table = tables.find((t) => t.id === (o.tableId ?? tab.tableId));
      const mine = lines.filter((l) => l.memberOrderId === o.id);
      const waitingMs = now - o.createdAt.getTime();
      return {
        id: o.id,
        placedAt: o.createdAt,
        waitingMinutes: Math.max(0, Math.floor(waitingMs / MINUTE)),
        overdue: waitingMs > s.member_order_accept_minutes * MINUTE,
        member: { id: o.memberId, name: m?.name ?? "?", code: m?.memberCode ?? "" },
        tier: bills.find((b) => b.id === tab.billId)?.tier ?? "WALK_IN",
        tab: { id: tab.id, code: tab.code, tableId: tab.tableId },
        table: table ? { id: table.id, number: table.number, area: table.area } : null,
        via: o.viaTableScan ? ("TABLE" as const) : ("CHECKIN" as const),
        total: mine.filter((l) => l.status !== "VOID").reduce((a, l) => a + l.netAmount, 0),
        lines: mine.map((l) => {
          const item = menu.find((x) => x.id === l.menuItemId);
          return { id: l.id, name: item?.name ?? "?", qty: l.qty, note: l.note, netAmount: l.netAmount, status: l.status, isAlcoholic: item?.isAlcoholic ?? false, prepMinutes: item?.prepMinutes ?? null };
        }),
      };
    }),
  };
}

/**
 * §1.2 "My tab" (and MO-1/MO-7 for the page): the open tab with each line's status, the running total and "Settle at
 * the bar before you leave", the orders on it, past tabs, whether ordering is possible now, and the family the member
 * may order for.
 */
export async function myBar(actor: Actor, opts: { forMemberId?: string | null; sessionToken?: string | null } = {}) {
  assertMemberActor(actor);
  const { member, onBehalf } = await orderFor(prisma, actor, opts.forMemberId);
  const s = await getSettings();
  const [presence, juniors, tabs] = await Promise.all([
    presenceOf(prisma, actor, opts.sessionToken, [...new Set([member.id, actor.memberId])]),
    prisma.member.findMany({ where: { guardianMemberId: actor.memberId, anonymisedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.tab.findMany({ where: { memberId: member.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21 }),
  ]);
  const open = tabs.find((t) => t.status === "OPEN") ?? null;
  const carried = tabs.filter((t) => t.status === "CARRIED");
  const past = tabs.filter((t) => t.status === "SETTLED");
  const bills = await prisma.bill.findMany({ where: { id: { in: tabs.map((t) => t.billId) } } });
  const billOf = (t: Tab) => bills.find((b) => b.id === t.billId)!;
  let openTab = null;
  if (open) {
    const [lines, orders, table] = await Promise.all([
      prisma.tabLine.findMany({ where: { tabId: open.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      prisma.memberOrder.findMany({ where: { tabId: open.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      open.tableId ? prisma.barTable.findUnique({ where: { id: open.tableId } }) : null,
    ]);
    const [menu, billLines] = await Promise.all([
      prisma.menuItem.findMany({ where: { id: { in: lines.map((l) => l.menuItemId) } }, select: { id: true, name: true, isAlcoholic: true, foodType: true } }),
      prisma.billLine.findMany({ where: { id: { in: lines.map((l) => l.billLineId) } }, select: { id: true, explanation: true } }),
    ]);
    const b = billOf(open);
    openTab = {
      id: open.id,
      code: open.code,
      table: table ? { id: table.id, number: table.number } : null,
      openedAt: open.createdAt,
      total: b.total,
      paid: netPaid(b),
      due: billDue(b),
      discountTotal: b.discountTotal,
      settleNote: SETTLE_REMINDER,
      lines: lines.map((l) => {
        const order = l.memberOrderId ? orders.find((o) => o.id === l.memberOrderId) : null;
        const item = menu.find((x) => x.id === l.menuItemId);
        return {
          id: l.id,
          name: item?.name ?? "?",
          isAlcoholic: item?.isAlcoholic ?? false,
          foodType: item?.foodType ?? null,
          qty: l.qty,
          note: l.note,
          netAmount: l.netAmount,
          discountAmount: l.discountAmount,
          explanation: billLines.find((x) => x.id === l.billLineId)?.explanation ?? "",
          status: l.status,
          source: l.memberOrderId ? ("APP" as const) : ("STAFF" as const),
          waitingForBar: order?.status === "PENDING" && l.status === "NEW",
          cancellable: order?.status === "PENDING" && l.status === "NEW" && !l.kitchenTicketId,
          voidReason: l.voidReason,
        };
      }),
      orders: orders.map((o) => ({
        id: o.id,
        placedAt: o.createdAt,
        status: o.status,
        total: o.total,
        rejectReason: o.rejectReason ? (o.rejectReason === "OTHER" ? o.rejectNote : REJECT_REASON_TEXT[o.rejectReason as RejectReason]) : null,
      })),
    };
  }
  return {
    member: { id: member.id, name: member.name, onBehalf },
    family: juniors.length ? [{ id: actor.memberId, name: "Me" }, ...juniors] : [],
    ordering: { ...presence, message: presence.atClub ? null : NOT_AT_CLUB_MESSAGE, autoAccept: s.auto_accept_member_orders, tabLimit: s.member_tab_limit },
    openTab,
    carried: carried.map((t) => ({ id: t.id, code: t.code, barDate: fromDbDate(t.barDate), total: billOf(t).total, due: billDue(billOf(t)), reason: t.carriedReason })),
    owed: [open, ...carried].filter((t): t is Tab => !!t).reduce((a, t) => a + billDue(billOf(t)), 0),
    past: past.slice(0, 20).map((t) => ({ id: t.id, code: t.code, barDate: fromDbDate(t.barDate), settledAt: t.settledAt, total: billOf(t).total, discountTotal: billOf(t).discountTotal, billId: t.billId })),
  };
}
