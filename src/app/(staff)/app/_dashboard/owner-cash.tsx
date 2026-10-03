"use client";
// v4 RN-5 Owner: the cash summary — cash collected today, cash in the drawers now, cash in the safe, refunds payable.
// Each figure opens the list behind it.
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Money } from "@/components/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "./kpi-card";

type F = { value: number; href: string };
type Cash = { collectedToday: F; inDrawers: F; inSafe: F; refundsPayable: F & { count: number; oldestDays: number | null } };

export function OwnerCash() {
  const state = useApi<Cash>("/api/dashboards/owner-cash", { pollMs: 30_000 });
  return (
    <DataState state={state}>
      {(c) => (
        <Card data-testid="owner-cash">
          <CardHeader><CardTitle>Cash</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Cash collected today" value={<Money paise={c.collectedToday.value} />} href={c.collectedToday.href} />
              <StatCard label="Cash in drawers now" value={<Money paise={c.inDrawers.value} />} href={c.inDrawers.href} />
              <StatCard label="Cash in the safe" value={<Money paise={c.inSafe.value} />} href={c.inSafe.href} />
              <StatCard
                label="Refunds payable"
                value={<Money paise={c.refundsPayable.value} />}
                href={c.refundsPayable.href}
                hint={c.refundsPayable.count ? `${c.refundsPayable.count} waiting at the desk${c.refundsPayable.oldestDays !== null ? ` · oldest ${c.refundsPayable.oldestDays} day${c.refundsPayable.oldestDays === 1 ? "" : "s"}` : ""}` : "Nothing waiting at the desk"}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </DataState>
  );
}
