// v6 §2.3 (SENDALL) SA-7/SA-8: POST confirms "Send all" for the current Messages to Send filter — creates the job and
// returns at once (a second click returns the running job); the job starts right after the response (and the worker
// keeps it going every minute). GET ?filter=…: the running (else latest) job for that filter.
// SA-0: WhatsApp is sent only through the official WhatsApp Cloud API — never WhatsApp Web automation.
import { after } from "next/server";
import { z } from "zod";
import { body, query, route } from "@/server/http";
import { currentSendAll, runSendAllJobs, sendAllSchema, startSendAll } from "@/server/services/messages/send-all";

export const GET = route(async ({ req, actor }) => currentSendAll(actor, query(req, z.object({ filter: z.string().max(4000).default("") })).filter));

export const POST = route(async ({ req, actor }) => {
  const res = await startSendAll(actor, await body(req, sendAllSchema));
  if (res.created) after(() => runSendAllJobs({ budgetMs: 50_000 }).then(() => undefined, (e) => console.error("[send-all]", e)));
  return res;
});
