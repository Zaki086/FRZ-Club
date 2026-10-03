import { route } from "@/server/http";
import { listExport } from "@/server/services/filters";

/** v3 §3.1: the filtered list as CSV (roles that may export). */
export const GET = route<{ name: string }>(async ({ req, actor, params }) => {
  const csv = await listExport(actor, params.name, Object.fromEntries(req.nextUrl.searchParams));
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${params.name}.csv"` } });
});
