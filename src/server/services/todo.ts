// Role panels: "Waiting for you" on each role's home page — what that person has to do next, counted from the same
// records the linked screens list. Read-only; an item appears only for someone who can act on it, and every number
// is read from the database (zero is shown as zero, never estimated).
import type { BillSource, Role } from "@prisma/client";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { prisma } from "../db";
import type { Actor, UserActor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { listStock } from "./inventory";
import { isOverdue } from "./invoices";
import { BILL_CAPABILITY } from "./payments";
import { getSettings } from "./settings";

export type TodoHome = "dashboard" | "shop" | "bar" | "finance";
export type TodoItem = { key: string; label: string; count: number; amount?: number; href: string; hint?: string };

/**
 * Which home page carries the to-do panel for each role. The front desk's to-dos are its "Today at the desk" strip
 * (desk.ts), and the kitchen's are the kitchen display itself.
 */
export const TODO_HOME: Partial<Record<Role, TodoHome>> = {
  OWNER: "dashboard",
  MANAGER: "dashboard",
  SHOP_STAFF: "shop",
  BAR_STAFF: "bar",
  ACCOUNTANT: "finance",
};

type Def = { key: string; when: (a: UserActor) => boolean; get: (a: UserActor) => Promise<Omit<TodoItem, "key">> };

const own = (a: UserActor) => a.userId;

/** Refund requests this person may decide: not their own, and a Manager only up to the limit (RF-3). */
const refundsToApprove: Def = {
  key: "refundsToApprove",
  when: (a) => can(a, "refunds.approve"),
  get: async (a) => {
    const s = await getSettings();
    const rows = await prisma.refundRequest.findMany({
      where: {
        status: "REQUESTED",
        OR: [{ requestedBy: null }, { requestedBy: { not: own(a) } }],
        ...(a.role === "OWNER" ? {} : { amount: { lte: s.refund_manager_limit } }),
      },
      select: { amount: true },
    });
    return { label: "Refunds to approve", count: rows.length, amount: rows.reduce((x, r) => x + r.amount, 0), href: "/app/refunds?status=REQUESTED" };
  },
};

/** Leave requests waiting for a decision (nobody decides their own). */
const leaveToApprove: Def = {
  key: "leaveToApprove",
  when: (a) => can(a, "leave.approve"),
  get: async (a) => ({
    label: "Leave to approve",
    count: await prisma.leaveRequest.count({ where: { status: "PENDING", ...(a.employeeId ? { employeeId: { not: a.employeeId } } : {}) } }),
    href: "/app/staff/leave?status=PENDING",
  }),
};

/** Price rules (promotions, bands) waiting for approval that this person may approve (PR-11 guardrails). */
const priceRulesToApprove: Def = {
  key: "priceRulesToApprove",
  when: (a) => can(a, "pricing.manage"),
  get: async (a) => {
    const rows = await prisma.priceRule.findMany({
      where: { status: "PENDING_APPROVAL", OR: [{ createdBy: null }, { createdBy: { not: own(a) } }] },
      select: { adjustType: true, adjustPct: true },
    });
    const limit = (await getSettings()).max_manager_discount_pct;
    const mine = a.role === "OWNER" ? rows : rows.filter((r) => r.adjustType !== "FLAT" && (r.adjustPct ?? 0) <= limit);
    return { label: "Price rules to approve", count: mine.length, href: "/app/pricing" };
  },
};

/** AT-4: shifts flagged for a missing clock-out that still have no clock-out. */
const missingClockOuts: Def = {
  key: "missingClockOuts",
  when: (a) => can(a, "attendance.correct"),
  get: async () => ({
    label: "Missing clock-outs",
    count: await prisma.attendance.count({ where: { clockOut: null, missingFlaggedAt: { not: null } } }),
    href: "/app/staff/attendance",
  }),
};

const dataRequests: Def = {
  key: "dataRequests",
  when: (a) => can(a, "privacy.manage"),
  get: async () => ({ label: "Data requests to decide", count: await prisma.dataRequest.count({ where: { status: "OPEN" } }), href: "/app/settings/privacy?status=OPEN" }),
};

/** Only the Owner approves payroll (payroll.ts). */
const payrollToApprove: Def = {
  key: "payrollToApprove",
  when: (a) => can(a, "payroll") && a.role === "OWNER",
  get: async () => ({ label: "Payroll to approve", count: await prisma.payrollRun.count({ where: { status: "DRAFT" } }), href: "/app/finance/payroll" }),
};

const payrollToPay: Def = {
  key: "payrollToPay",
  when: (a) => can(a, "payroll"),
  get: async () => ({ label: "Approved payroll to pay", count: await prisma.payrollRun.count({ where: { status: "APPROVED" } }), href: "/app/finance/payroll" }),
};

/** Closed drawers whose counted cash has not been banked yet (recordDeposit). */
const drawersToBank: Def = {
  key: "drawersToBank",
  when: (a) => can(a, "cash.reconcile"),
  get: async () => {
    const rows = await prisma.cashDrawerSession.findMany({ where: { closedAt: { not: null }, depositedAt: null, cashCounted: { gt: 0 } }, select: { cashCounted: true } });
    return { label: "Drawer cash to bank", count: rows.length, amount: rows.reduce((x, r) => x + (r.cashCounted ?? 0), 0), href: "/app/finance/drawers" };
  },
};

const supplierBills: Def = {
  key: "supplierBills",
  when: (a) => can(a, "expenses.manage"),
  get: async () => {
    const agg = await prisma.expenseBill.aggregate({ where: { status: "UNPAID" }, _count: true, _sum: { amount: true } });
    return { label: "Supplier bills to pay", count: agg._count, amount: agg._sum.amount ?? 0, href: "/app/finance/expenses?status=UNPAID" };
  },
};

/** OVERDUE is derived (issued or part-paid, past the due date) — the same rule as the invoices list. */
const overdueInvoices: Def = {
  key: "overdueInvoices",
  when: (a) => can(a, "invoices"),
  get: async () => {
    const today = istDate(clock.now());
    const rows = await prisma.invoice.findMany({ where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { not: null } }, select: { status: true, dueDate: true } });
    return { label: "Overdue invoices", count: rows.filter((r) => isOverdue(r, today)).length, href: "/app/finance/invoices?status=OVERDUE" };
  },
};

/** Paid online orders still to prepare (CONFIRMED → ready for pickup / packed). */
const ordersToPrepare: Def = {
  key: "ordersToPrepare",
  when: (a) => can(a, "shop.fulfil"),
  get: async () => ({ label: "Online orders to prepare", count: await prisma.shopOrder.count({ where: { status: "CONFIRMED" } }), href: "/app/shop/orders" }),
};

const ordersToHandOver: Def = {
  key: "ordersToHandOver",
  when: (a) => can(a, "shop.fulfil"),
  get: async () => ({
    label: "Orders to hand over",
    count: await prisma.shopOrder.count({ where: { status: { in: ["READY_FOR_PICKUP", "PACKED"] } } }),
    hint: "Ready for pickup or packed for delivery",
    href: "/app/shop/orders",
  }),
};

const restringOpen: Def = {
  key: "restringOpen",
  when: (a) => can(a, "shop.fulfil"),
  get: async () => ({ label: "Rackets to restring", count: await prisma.serviceTicket.count({ where: { status: { in: ["RECEIVED", "IN_PROGRESS"] } } }), href: "/app/shop/restring" }),
};

/** The same "low" rule as the stock screen (available ≤ reorder level on tracked items). */
const lowStock: Def = {
  key: "lowStock",
  when: (a) => can(a, "shop.stock"),
  get: async (a) => ({ label: "Low-stock items", count: (await listStock(a, { lowOnly: true })).length, href: "/app/shop/stock?filter=low" }),
};

const deliveriesToReceive: Def = {
  key: "deliveriesToReceive",
  when: (a) => can(a, "shop.stock"),
  get: async () => ({ label: "Purchase orders to receive", count: await prisma.purchaseOrder.count({ where: { status: "ORDERED" } }), href: "/app/shop/purchasing?status=ORDERED" }),
};

/** Kitchen items marked READY that nobody has served yet (the "Ready to serve" queue). */
const readyToServe: Def = {
  key: "readyToServe",
  when: (a) => can(a, "bar.operate"),
  get: async () => ({ label: "Ready to serve", count: await prisma.tabLine.count({ where: { status: "READY" } }), href: "/app/bar/ready" }),
};

/** Approved refunds waiting to be paid out at this person's counter: bills they can take payments on (RF-4). */
const refundsToPayOut: Def = {
  key: "refundsToPayOut",
  when: (a) => can(a, "refunds.request"),
  get: async (a) => {
    const sources = (Object.keys(BILL_CAPABILITY) as BillSource[]).filter((s) => can(a, BILL_CAPABILITY[s]));
    const rows = await prisma.payment.findMany({
      where: { type: "REFUND", status: "PENDING", refundRequestId: { not: null }, bill: { sourceType: { in: sources } } },
      select: { refundRequestId: true, amount: true },
    });
    return { label: "Refunds to pay out", count: new Set(rows.map((r) => r.refundRequestId)).size, amount: rows.reduce((x, r) => x + r.amount, 0), href: "/app/refunds?status=APPROVED" };
  },
};

/**
 * Per home: what waits for that person. The Owner/Manager dashboard already shows low stock, open orders, overdue
 * lead follow-ups and pending club cancellations in its own sections, so its panel is the approvals only.
 */
const HOME_ITEMS: Record<TodoHome, Def[]> = {
  dashboard: [refundsToApprove, leaveToApprove, priceRulesToApprove, missingClockOuts, payrollToApprove, dataRequests],
  shop: [ordersToPrepare, ordersToHandOver, restringOpen, lowStock, deliveriesToReceive, refundsToPayOut],
  bar: [readyToServe, refundsToPayOut],
  finance: [drawersToBank, supplierBills, overdueInvoices, payrollToPay],
};

/** The keys a role's panel can show (before the capability check), for tests and docs. */
export function todoKeys(home: TodoHome): string[] {
  return HOME_ITEMS[home].map((d) => d.key);
}

/** What is waiting for this staff member, on their own home page. Empty for roles without a to-do panel. */
export async function myTodo(actor: Actor): Promise<{ home: TodoHome | null; items: TodoItem[] }> {
  assertCan(actor, "staff.self");
  if (actor.kind !== "USER") return { home: null, items: [] };
  const home = TODO_HOME[actor.role] ?? null;
  if (!home) return { home, items: [] };
  const defs = HOME_ITEMS[home].filter((d) => d.when(actor));
  const items = await Promise.all(defs.map(async (d) => ({ key: d.key, ...(await d.get(actor)) })));
  return { home, items };
}

/** Lead follow-ups assigned to this person that are past due (the CRM board's "Overdue" rule). */
export async function myOverdueFollowUps(actor: UserActor): Promise<number> {
  return prisma.lead.count({ where: { assignedTo: actor.userId, status: { in: ["NEW", "CONTACTED", "QUOTED"] }, nextFollowUpAt: { lt: clock.now() } } });
}

/** WhatsApp messages queued for staff to send by hand (the "Messages to send" list: to send or opened, not marked sent). */
export async function messagesToSend(): Promise<number> {
  return prisma.notificationDelivery.count({ where: { channel: "WHATSAPP_MANUAL", status: { in: ["QUEUED", "LINK_OPENED"] } } });
}
