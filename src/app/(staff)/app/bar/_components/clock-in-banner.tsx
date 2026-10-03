"use client";
// BR-10: every bar payment records the shift; prompt staff to clock in before taking money.
import { useState } from "react";
import { Clock } from "lucide-react";
import { api, useApi } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { parseRupees } from "@/lib/money";
import type { StaffMe } from "./types";
import { toRejection, type Rejection } from "./err";

export function ClockInBanner() {
  const me = useApi<StaffMe>("/api/staff/me");
  const [float, setFloat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  if (me.error || !me.data || me.data.clockedIn) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <Clock className="h-4 w-4" />
      <span className="font-medium">You are not clocked in.</span> Payments you take are linked to your shift for the cash count.
      <Input className="h-9 w-40 bg-white" inputMode="decimal" placeholder="Opening float ₹" value={float} onChange={(e) => setFloat(e.target.value)} aria-label="Opening float" />
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api("/api/staff/clock-in", { body: { openingFloat: float ? (parseRupees(float) ?? 0) : 0 } });
            await me.reload();
          } catch (e) {
            setError(toRejection(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Clock in
      </Button>
      <RejectionBanner error={error} />
    </div>
  );
}
