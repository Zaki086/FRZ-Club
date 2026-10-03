import { fmtDate } from "@/lib/time";

/** Server dates come as ISO strings (Prisma @db.Date → 'YYYY-MM-DDT00:00:00.000Z'). */
export function dateOnly(v: string | null | undefined): string {
  if (!v) return "—";
  return fmtDate(v.slice(0, 10));
}

export const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
