"use client";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatINR } from "@/lib/money";
import { fmtDay } from "@/lib/time";
import { SOURCES, SOURCE_COLOR, SOURCE_LABEL } from "./types";

/** DB-4: daily revenue stacked by source (values straight from the ledger). */
export function DailyRevenueChart({ data }: { data: Array<Record<string, number | string>> }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d: string) => fmtDay(d)} tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={(v: number) => formatINR(v)} tick={{ fontSize: 11 }} width={80} />
          <Tooltip
            formatter={(v, name) => [formatINR(Number(v)), SOURCE_LABEL[String(name)] ?? String(name)]}
            labelFormatter={(d) => fmtDay(String(d))}
          />
          <Legend formatter={(v: string) => SOURCE_LABEL[v] ?? v} />
          {SOURCES.map((s) => (
            <Bar key={s} dataKey={s} stackId="rev" fill={SOURCE_COLOR[s]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** DB-4: utilization heatmap — % of each court-hour that was booked or held for social play. */
export function UtilizationHeatmap({ hours, courts }: { hours: number[]; courts: Array<{ court: string; cells: number[] }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-[11px]">
        <thead>
          <tr>
            <th className="sticky left-0 bg-card px-1 text-left font-medium text-muted-foreground">Court</th>
            {hours.map((h) => (
              <th key={h} className="px-0.5 font-medium text-muted-foreground">
                {String(h).padStart(2, "0")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {courts.map((c) => (
            <tr key={c.court}>
              <td className="sticky left-0 whitespace-nowrap bg-card px-1 font-medium">{c.court}</td>
              {c.cells.map((v, i) => (
                <td
                  key={i}
                  title={`${c.court} ${String(hours[i]).padStart(2, "0")}:00 — ${v}% booked`}
                  className="h-7 min-w-7 rounded text-center tabular"
                  style={{ background: v > 0 ? `rgba(15, 81, 50, ${0.12 + (Math.min(v, 100) / 100) * 0.83})` : "var(--muted)", color: v >= 55 ? "#fff" : "var(--foreground)" }}
                >
                  {v > 0 ? v : ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-muted-foreground">Cell = % of that hour booked across the period (regular bookings and social play).</p>
    </div>
  );
}
