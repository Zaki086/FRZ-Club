import { z } from "zod";
import { body, route } from "@/server/http";
import { cancelInvoice, getInvoice, issueInvoice } from "@/server/services/invoices";

export const GET = route<{ id: string }>(async ({ actor, params }) => getInvoice(actor, params.id));

/** Actions: issue (DRAFT → ISSUED) or cancel (with a reason). */
export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const input = await body(req, z.discriminatedUnion("action", [
    z.object({ action: z.literal("issue") }),
    z.object({ action: z.literal("cancel"), reason: z.string().min(3) }),
  ]));
  return input.action === "issue" ? issueInvoice(actor, params.id) : cancelInvoice(actor, params.id, input.reason);
});
