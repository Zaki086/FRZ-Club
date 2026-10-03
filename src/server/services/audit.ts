// Audit trail (plan §2). Written inside the same transaction as the mutation it describes.
import type { Prisma, Role } from "@prisma/client";
import { istDate, istDayRange, isValidDateStr } from "@/lib/time";
import { clock } from "@/lib/clock";
import type { Tx } from "../db";
import { prisma } from "../db";
import { actorId, actorLabel, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";

function toJson(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === undefined || v === null) return undefined;
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

export async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string,
  data: { before?: unknown; after?: unknown; reason?: string | null } = {},
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: actorId(actor),
      actorLabel: actorLabel(actor),
      action,
      entity,
      entityId,
      before: toJson(data.before),
      after: toJson(data.after),
      reason: data.reason ?? null,
      at: clock.now(),
    },
  });
}

export async function listAudit(
  actor: Actor,
  q: { entity?: string; entityId?: string; action?: string; search?: string; limit?: number; before?: string },
) {
  assertCan(actor, "audit");
  return prisma.auditLog.findMany({
    where: {
      entity: q.entity || undefined,
      entityId: q.entityId || undefined,
      action: q.action ? { contains: q.action } : undefined,
      actorLabel: q.search ? { contains: q.search, mode: "insensitive" } : undefined,
      at: q.before ? { lt: new Date(q.before) } : undefined,
    },
    orderBy: { at: "desc" },
    take: Math.min(q.limit ?? 100, 500),
  });
}

/**
 * Completion pass §7 (manager): staff activity for one IST day — every audited action by staff, optionally one
 * person. Managers don't see the Owner's actions.
 */
export async function listStaffActivity(actor: Actor, q: { date?: string; userId?: string }) {
  assertCan(actor, "staff.activity");
  const day = q.date && isValidDateStr(q.date) ? q.date : istDate(clock.now());
  const [from, to] = istDayRange(day);
  const roles: Role[] = actor.kind === "USER" && actor.role === "OWNER" ? ["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT", "KITCHEN"] : ["MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT", "KITCHEN"];
  const staff = await prisma.user.findMany({ where: { role: { in: roles } }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } });
  const ids = q.userId ? staff.filter((s) => s.id === q.userId).map((s) => s.id) : staff.map((s) => s.id);
  const rows = await prisma.auditLog.findMany({ where: { actorId: { in: ids }, at: { gte: from, lt: to } }, orderBy: { at: "desc" }, take: 500 });
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.actorId!, (counts.get(r.actorId!) ?? 0) + 1));
  return {
    date: day,
    staff: staff.map((s) => ({ ...s, actions: counts.get(s.id) ?? 0 })),
    rows: rows.map((r) => ({ id: r.id, at: r.at, action: r.action, entity: r.entity, entityId: r.entityId, reason: r.reason, who: staff.find((s) => s.id === r.actorId)?.name ?? r.actorLabel })),
  };
}
