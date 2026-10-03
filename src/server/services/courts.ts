// Courts per sport (CT-1, R-08). Archived, never deleted.
import type { Sport } from "@prisma/client";
import { z } from "zod";
import { prisma, withTx, type Tx } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";

export const DEFAULT_MAX_PLAYERS: Record<Sport, number> = { TENNIS: 4, PADEL: 4, BADMINTON: 4, CRICKET: 6 };

export const courtSchema = z.object({
  name: z.string().trim().min(1).max(40),
  sport: z.enum(["TENNIS", "CRICKET", "PADEL", "BADMINTON"]),
  maxPlayers: z.number().int().min(1).max(20).optional(),
  sortOrder: z.number().int().optional(),
});

export async function createCourt(actor: Actor, raw: z.infer<typeof courtSchema>, outer?: Tx) {
  assertCan(actor, "settings");
  const input = courtSchema.parse(raw);
  return withTx(async (tx) => {
    const court = await tx.court.create({
      data: {
        name: input.name,
        sport: input.sport,
        maxPlayers: input.maxPlayers ?? DEFAULT_MAX_PLAYERS[input.sport],
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await audit(tx, actor, "court.create", "court", court.id, { after: court });
    return court;
  }, outer);
}

export async function setCourtActive(actor: Actor, courtId: string, active: boolean) {
  assertCan(actor, "settings");
  return withTx(async (tx) => {
    const before = await tx.court.findUnique({ where: { id: courtId } });
    if (!before) throw new DomainError("NOT_FOUND", "Court was not found.");
    const court = await tx.court.update({ where: { id: courtId }, data: { active } });
    await audit(tx, actor, active ? "court.activate" : "court.deactivate", "court", courtId, {
      before: { active: before.active },
      after: { active },
    });
    return court;
  });
}

export async function listCourts(opts: { includeInactive?: boolean } = {}) {
  return prisma.court.findMany({
    where: { archivedAt: null, active: opts.includeInactive ? undefined : true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}
