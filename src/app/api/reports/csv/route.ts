import { z } from "zod";
import { query, route } from "@/server/http";
import { exportCsv, periodSchema } from "@/server/services/reports";
import { DATE_PRESETS } from "@/server/services/filters/core";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, periodSchema.extend({
    report: z.enum(["drilldown", "ledger", "gst", "gstr1_b2b", "gstr1_b2cs", "gstr1_hsn", "tally", "dashboard"]),
    metric: z.string().optional(), source: z.string().optional(), method: z.string().optional(),
    // v3 §3.2: the ledger list's filters (date preset or ALL, direction, search) for its Tally day book.
    range: z.enum([...DATE_PRESETS, "ALL"]).optional(), direction: z.string().optional(), q: z.string().max(100).optional(),
  }));
  const csv = await exportCsv(actor, q.report, q);
  const span = q.range ? q.range.toLowerCase() : q.period.toLowerCase();
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="champions-${q.report}-${span}.csv"` },
  });
});
