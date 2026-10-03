import { z } from "zod";
import { body, query, route } from "@/server/http";
import { createDraft, invoiceDraftSchema, listInvoices } from "@/server/services/invoices";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, z.object({ status: z.string().optional(), clientId: z.string().optional(), memberId: z.string().optional() }));
  return listInvoices(actor, q);
});

export const POST = route(async ({ req, actor }) => createDraft(actor, await body(req, invoiceDraftSchema)));
