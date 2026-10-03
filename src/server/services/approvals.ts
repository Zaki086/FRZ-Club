// v4 RN-4 — "Needs your approval" on the Owner and Manager dashboards: what this person may decide right now, read
// from the same records the detail pages list, and decided inline through the same services those pages use (each of
// which checks the rules and writes its own audit row). Nothing here decides anything itself.
//  - Refund requests: not their own; a Manager only up to `refund_manager_limit` (RF-3).
//  - Leave requests: not their own (ST-4/LV-3).
//  - Attendance: there is no correction-request flow, so the rows are the flagged missing clock-outs (AT-4) that
//    still need a correction; they link to the correction (AT-5 needs the times and a reason), no inline decision.
//  - Drawer variances over the tolerance (CD-6): rows and decisions come from drawers.ts.
import { z } from "zod";
import { fmtDate, fmtDateTime, fromDbDate } from "@/lib/time";
import { prisma } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { can } from "../rbac/permissions";
import { APPROVAL_HREF } from "./approval-links";
import { approveDrawerVariance, listDrawerVarianceApprovals, rejectDrawerVariance } from "./drawers";
import { REFUND_REASON_LABEL, type RefundReason } from "./refund-records";
import { approveRefund, rejectRefund } from "./refunds";
import { getSettings } from "./settings";
import { decideLeave } from "./staff";

export type ApprovalItem = {
  kind: "REFUND" | "LEAVE" | "ATTENDANCE" | "DRAWER_VARIANCE";
  id: string;
  title: string;
  detail: string;
  amountPaise: number | null;
  requestedBy: string;
  requestedAt: string;
  href: string;
};

export { APPROVAL_HREF };

const VIA_LABEL: Record<string, string> = { MEMBER: "Member (portal)", SYSTEM: "Automatic (policy)", STAFF: "Staff" };

async function refundItems(actor: Actor): Promise<ApprovalItem[]> {
  if (!can(actor, "refunds.approve") || actor.kind !== "USER") return [];
  const s = await getSettings();
  const rows = await prisma.refundRequest.findMany({
    where: {
      status: "REQUESTED",
      OR: [{ requestedBy: null }, { requestedBy: { not: actor.userId } }],
      ...(actor.role === "OWNER" ? {} : { amount: { lte: s.refund_manager_limit } }),
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const [bills, users] = await Promise.all([
    prisma.bill.findMany({ where: { id: { in: rows.map((r) => r.billId) } }, select: { id: true, customerName: true } }),
    prisma.user.findMany({ where: { id: { in: rows.map((r) => r.requestedBy).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  return rows.map((r) => ({
    kind: "REFUND" as const,
    id: r.id,
    title: `Refund ${r.code} · ${bills.find((b) => b.id === r.billId)?.customerName ?? "customer"}`,
    detail: [REFUND_REASON_LABEL[r.reason as RefundReason] ?? r.reason, r.note].filter(Boolean).join(" · "),
    amountPaise: r.amount,
    requestedBy: (r.requestedBy && users.find((u) => u.id === r.requestedBy)?.name) || VIA_LABEL[r.requestedVia] || r.requestedVia,
    requestedAt: r.createdAt.toISOString(),
    href: APPROVAL_HREF.refund(r.id),
  }));
}

async function leaveItems(actor: Actor): Promise<ApprovalItem[]> {
  if (!can(actor, "leave.approve")) return [];
  const own = actor.kind === "USER" ? actor.employeeId : null;
  const rows = await prisma.leaveRequest.findMany({
    where: { status: "PENDING", ...(own ? { employeeId: { not: own } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, user: { select: { name: true } } } });
  return rows.map((r) => {
    const name = emps.find((e) => e.id === r.employeeId)?.user.name ?? "Employee";
    const from = fromDbDate(r.startDate);
    const to = fromDbDate(r.endDate);
    return {
      kind: "LEAVE" as const,
      id: r.id,
      title: `Leave · ${name}`,
      detail: `${r.type.charAt(0)}${r.type.slice(1).toLowerCase()} leave ${from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`} (${r.days} day${r.days === 1 ? "" : "s"}) · ${r.reason}`,
      amountPaise: null,
      requestedBy: name,
      requestedAt: r.createdAt.toISOString(),
      href: APPROVAL_HREF.leave(r.employeeId),
    };
  });
}

/** AT-4: flagged missing clock-outs still open (nobody corrects their own attendance). */
async function attendanceItems(actor: Actor): Promise<ApprovalItem[]> {
  if (!can(actor, "attendance.correct")) return [];
  const own = actor.kind === "USER" ? actor.employeeId : null;
  const rows = await prisma.attendance.findMany({
    where: { clockOut: null, missingFlaggedAt: { not: null }, ...(own ? { employeeId: { not: own } } : {}) },
    orderBy: { clockIn: "asc" },
    take: 100,
  });
  const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, user: { select: { name: true } } } });
  return rows.map((r) => {
    const name = emps.find((e) => e.id === r.employeeId)?.user.name ?? "Employee";
    return {
      kind: "ATTENDANCE" as const,
      id: r.id,
      title: `Missing clock-out · ${name}`,
      detail: `Clocked in ${fmtDateTime(r.clockIn)} and never clocked out. Correct the clock-out with a reason.`,
      amountPaise: null,
      requestedBy: name,
      requestedAt: (r.missingFlaggedAt ?? r.clockIn).toISOString(),
      href: APPROVAL_HREF.attendance(r.employeeId),
    };
  });
}

/** RN-4: everything this person may decide now, oldest first. Empty for roles that approve nothing. */
export async function listApprovals(actor: Actor): Promise<ApprovalItem[]> {
  if (actor.kind !== "USER") return [];
  const groups = await Promise.all([refundItems(actor), leaveItems(actor), attendanceItems(actor), listDrawerVarianceApprovals(actor)]);
  return groups.flat().sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export const decideApprovalSchema = z
  .object({
    kind: z.enum(["REFUND", "LEAVE", "ATTENDANCE", "DRAWER_VARIANCE"]),
    id: z.string().min(1).max(64),
    decision: z.enum(["APPROVE", "REJECT"]),
    reason: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.decision !== "REJECT" || (v.reason ?? "").length >= 3, { message: "Say why you are rejecting it (at least 3 characters).", path: ["reason"] });

/**
 * RN-4 inline Approve / Reject (a reason is required to reject). Each kind goes to the service its own page uses, so
 * the limits, "never your own" and the audit row are exactly the same as there.
 */
export async function decideApproval(actor: Actor, raw: z.input<typeof decideApprovalSchema>) {
  const input = decideApprovalSchema.parse(raw);
  const approve = input.decision === "APPROVE";
  switch (input.kind) {
    case "REFUND":
      return approve ? approveRefund(actor, input.id, input.reason || undefined) : rejectRefund(actor, input.id, input.reason!);
    case "LEAVE":
      return decideLeave(actor, input.id, approve ? "APPROVED" : "REJECTED", input.reason || undefined);
    case "DRAWER_VARIANCE":
      return approve ? approveDrawerVariance(actor, input.id) : rejectDrawerVariance(actor, input.id, input.reason!);
    case "ATTENDANCE":
      throw new DomainError("VALIDATION_FAILED", "A missing clock-out is corrected on the attendance page, with the right time and a reason.");
  }
}
