"use client";
// v3 §3.3: dates read as "in 3 days" / "2 h ago", with the exact IST date and time on hover.
import { fmtDate, fmtDateTime, istDate } from "@/lib/time";

export function relative(when: Date | string, now = new Date()): string {
  const d = typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when) ? new Date(`${when}T00:00:00+05:30`) : new Date(when);
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(mins);
  const say = (n: number, unit: string) => (mins >= 0 ? `in ${n} ${unit}${n === 1 ? "" : "s"}` : `${n} ${unit}${n === 1 ? "" : "s"} ago`);
  if (abs < 1) return "now";
  if (abs < 60) return say(abs, "min");
  if (abs < 24 * 60) return say(Math.round(abs / 60), "hour");
  const days = Math.round((Date.parse(istDate(d)) - Date.parse(istDate(now))) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (Math.abs(days) < 60) return days > 0 ? `in ${days} days` : `${-days} days ago`;
  return fmtDate(istDate(d));
}

export function RelTime({ when, className }: { when: Date | string | null | undefined; className?: string }) {
  if (!when) return <span className={className}>—</span>;
  const exact = typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when) ? fmtDate(when) : fmtDateTime(when);
  return (
    <time className={className} dateTime={typeof when === "string" ? when : when.toISOString()} title={exact}>
      {relative(when)}
    </time>
  );
}
