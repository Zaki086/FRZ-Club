// Audit trail (plan §2). Written inside the same transaction as the mutation it describes.
import type { Prisma } from "@prisma/client";
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
