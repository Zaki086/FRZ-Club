import { z } from "zod";
import { body, query, route } from "@/server/http";
import { createMember, createMemberSchema } from "@/server/services/membership";
import { listMembers, searchMembers } from "@/server/services/members";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, z.object({ q: z.string().optional(), tier: z.string().optional(), status: z.string().optional() }));
  if (q.q) return searchMembers(actor, q.q);
  return listMembers(actor, { tier: q.tier || undefined, status: q.status || undefined });
});

export const POST = route(async ({ req, actor, idempotencyKey }) => createMember(actor, await body(req, createMemberSchema), idempotencyKey));
