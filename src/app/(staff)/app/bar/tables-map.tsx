"use client";
import Link from "next/link";
import { Users } from "lucide-react";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { cn } from "@/components/ui/cn";
import { OpenTabDialog } from "./_components/open-tab-dialog";
import type { TabSummary, TablesData } from "./_components/types";

function TabChip({ t }: { t: TabSummary }) {
  return (
    <Link href={`/app/bar/tabs/${t.id}`} className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm hover:border-primary hover:bg-accent" data-testid="tab-chip">
      <span className="min-w-0">
        <span className="block truncate font-semibold">{t.payer}</span>
        <span className="font-mono text-xs text-muted-foreground">{t.code}</span>
      </span>
      <span className="flex flex-col items-end gap-0.5">
        <TierBadge tier={t.tier} />
        <Money paise={t.due} className="text-xs font-medium" />
      </span>
    </Link>
  );
}

export function TablesMap() {
  const state = useApi<TablesData>("/api/bar/tables", { pollMs: 10000 });
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <OpenTabDialog tables={d.tables} />
            <Button asChild variant="outline" size="lg"><Link href="/app/bar/ready">Ready to serve</Link></Button>
            <Button asChild variant="outline" size="lg"><Link href="/app/bar/kds">Kitchen display</Link></Button>
            <Button asChild variant="outline" size="lg"><Link href="/app/bar/tabs">All tabs</Link></Button>
            <span className="ml-auto text-sm text-muted-foreground">
              {d.tables.filter((t) => t.status === "OCCUPIED").length}/{d.tables.length} tables occupied · {d.tables.reduce((a, t) => a + t.tabs.length, 0) + d.unassigned.length} open tabs
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {d.tables.map((t) => (
              <Card key={t.id} className={cn("flex flex-col gap-2 p-3", t.status === "OCCUPIED" ? "border-amber-300 bg-amber-50/60" : "")}>
                <div className="flex items-center justify-between">
                  <p className="text-lg font-bold">Table {t.number}</p>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", t.status === "OCCUPIED" ? "bg-amber-200 text-amber-900" : "bg-green-100 text-green-800")}>
                    {t.status === "OCCUPIED" ? "Occupied" : "Free"}
                  </span>
                </div>
                <p className="flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3 w-3" />{t.capacity} · {t.area}</p>
                <div className="flex flex-col gap-1.5">
                  {t.tabs.map((tab) => <TabChip key={tab.id} t={tab} />)}
                </div>
                <OpenTabDialog
                  tables={d.tables}
                  defaultTableId={t.id}
                  trigger={<Button variant="outline" size="sm" className="mt-auto">+ Tab at table {t.number}</Button>}
                />
              </Card>
            ))}
          </div>
          <Card className="p-3">
            <p className="mb-2 font-semibold">Bar counter (no table)</p>
            {d.unassigned.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open tabs at the counter.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {d.unassigned.map((tab) => <TabChip key={tab.id} t={tab} />)}
              </div>
            )}
          </Card>
        </div>
      )}
    </DataState>
  );
}
