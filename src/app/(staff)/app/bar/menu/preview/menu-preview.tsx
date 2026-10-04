"use client";
// v5 MN-4: the member's menu (the same MenuView the portal renders), for a member of the chosen plan.
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useApi } from "@/components/api";
import { MenuView, type MenuViewCategory } from "@/components/menu-view";
import { DataState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";

type Preview = { as: string; label: string; pricedFor: string | null; note: string | null; categories: MenuViewCategory[] };
const AS = [["GOLD", "Gold member"], ["SILVER", "Silver member"], ["JUNIOR", "Junior member (no alcohol)"], ["NONE", "Member without a plan"]] as const;

export function MenuPreview() {
  const [as, setAs] = useState<(typeof AS)[number][0]>("SILVER");
  const state = useApi<Preview>(`/api/bar/menu/preview?as=${as}`);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/app/bar/menu"><ArrowLeft className="h-4 w-4" /> Menu</Link></Button>
        <span className="text-sm">Preview as</span>
        <Select className="w-64" aria-label="Preview as" value={as} onChange={(e) => setAs(e.target.value as (typeof AS)[number][0])}>
          {AS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </div>
      <DataState state={state}>
        {(p) => (
          <div className="mx-auto w-full max-w-md rounded-[2rem] border-8 border-ink/80 bg-background p-3 shadow-lift" data-testid="menu-preview">
            <MenuView
              categories={p.categories}
              header={<p className="text-xs text-muted-foreground">{p.note ?? `Prices for ${p.pricedFor ?? p.label}.`}</p>}
            />
          </div>
        )}
      </DataState>
    </div>
  );
}
