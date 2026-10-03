import { z } from "zod";
import { body, query, route } from "@/server/http";
import { createLead, leadSchema, listLeads } from "@/server/services/crm";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, z.object({ status: z.string().optional(), mine: z.string().optional(), q: z.string().optional() }));
  return listLeads(actor, { status: q.status || undefined, mine: q.mine === "1", search: q.q || undefined });
});

export const POST = route(async ({ req, actor }) => createLead(actor, await body(req, leadSchema)));
