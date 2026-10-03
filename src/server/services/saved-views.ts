// v3 §3.1: saved list views — a user's named query string for a list, at most 10 per list.
import { z } from "zod";
import { prisma } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertUser } from "../rbac/permissions";
import { LISTS } from "./filters";
import { assertListAccess, parseQuery } from "./filters/core";

export const MAX_SAVED_VIEWS = 10;
export const savedViewSchema = z.object({ list: z.string().min(1).max(40), name: z.string().trim().min(1).max(60), query: z.string().max(2000) });

function checkList(actor: Actor, list: string, query?: string) {
  const def = LISTS[list];
  if (!def) throw new DomainError("NOT_FOUND", "List was not found.");
  assertListAccess(def, actor);
  if (query !== undefined) parseQuery(def, Object.fromEntries(new URLSearchParams(query))); // only valid filters are saved
}

export async function listSavedViews(actor: Actor, list: string) {
  assertUser(actor);
  checkList(actor, list);
  return prisma.savedView.findMany({ where: { userId: actor.userId, list }, orderBy: { name: "asc" }, select: { id: true, name: true, query: true } });
}

/** Save (or overwrite by name) a view. */
export async function saveView(actor: Actor, raw: z.infer<typeof savedViewSchema>) {
  assertUser(actor);
  const input = savedViewSchema.parse(raw);
  checkList(actor, input.list, input.query);
  const existing = await prisma.savedView.findUnique({ where: { userId_list_name: { userId: actor.userId, list: input.list, name: input.name } } });
  if (!existing && (await prisma.savedView.count({ where: { userId: actor.userId, list: input.list } })) >= MAX_SAVED_VIEWS) {
    throw new DomainError("VALIDATION_FAILED", `You can keep up to ${MAX_SAVED_VIEWS} saved views per list; delete one first.`);
  }
  return prisma.savedView.upsert({
    where: { userId_list_name: { userId: actor.userId, list: input.list, name: input.name } },
    create: { userId: actor.userId, list: input.list, name: input.name, query: input.query },
    update: { query: input.query },
    select: { id: true, name: true, query: true },
  });
}

/** Saved views are personal preferences, not records: deleting one is allowed. */
export async function deleteView(actor: Actor, id: string) {
  assertUser(actor);
  const v = await prisma.savedView.findUnique({ where: { id } });
  if (!v || v.userId !== actor.userId) throw new DomainError("NOT_FOUND", "Saved view was not found.");
  await prisma.savedView.delete({ where: { id } });
  return { ok: true };
}
