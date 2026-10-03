import { z } from "zod";
import { query, route } from "@/server/http";
import { exportCsv, periodSchema } from "@/server/services/reports";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, periodSchema.extend({ report: z.enum(["drilldown", "ledger", "gst", "dashboard"]), metric: z.string().optional(), source: z.string().optional(), method: z.string().optional() }));
  const csv = await exportCsv(actor, q.report, q);
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="champions-${q.report}-${q.period.toLowerCase()}.csv"` },
  });
});
