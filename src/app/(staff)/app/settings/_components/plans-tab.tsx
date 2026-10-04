"use client";
import { useState } from "react";
import { api, useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { TierBadge } from "@/components/badges";
import { assertNumbers, fromRupeeText, SaveBar, toInt, toRupeeText } from "./shared";

type Plan = {
  id: string; code: string; name: string; description: string; price1m: number; price3m: number; price12m: number; socialFee: number;
  shopDiscountPct: number; barDiscountPct: number; advanceBookingDays: number; alcoholAllowed: boolean; active: boolean;
  courtFees: Array<{ sport: string; fee: number }>;
};
const SPORTS = ["TENNIS", "CRICKET", "PADEL", "BADMINTON"] as const;

export function PlansTab() {
  const plans = useApi<Plan[]>("/api/plans");
  return (
    <div className="flex flex-col gap-3">
      <DataState state={plans} isEmpty={(d) => d.length === 0} empty={{ title: "No plans" }}>
        {(rows) => (
          <div className="grid gap-4 lg:grid-cols-3">
            {rows.map((p) => (
              <PlanEditor key={`${p.id}-${p.price1m}-${p.socialFee}`} plan={p} onSaved={() => void plans.reload()} />
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}

function PlanEditor({ plan, onSaved }: { plan: Plan; onSaved: () => void }) {
  const fee = (s: string) => plan.courtFees.find((f) => f.sport === s)?.fee ?? 0;
  const [f, setF] = useState({
    name: plan.name, description: plan.description, price1m: toRupeeText(plan.price1m), price3m: toRupeeText(plan.price3m), price12m: toRupeeText(plan.price12m),
    socialFee: toRupeeText(plan.socialFee), shop: String(plan.shopDiscountPct), bar: String(plan.barDiscountPct), days: String(plan.advanceBookingDays),
    alcohol: plan.alcoholAllowed, active: plan.active,
    TENNIS: toRupeeText(fee("TENNIS")), CRICKET: toRupeeText(fee("CRICKET")), PADEL: toRupeeText(fee("PADEL")), BADMINTON: toRupeeText(fee("BADMINTON")),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <TierBadge tier={plan.code} /> {plan.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field label="Name"><Input value={f.name} onChange={set("name")} /></Field>
        <Field label="Description"><Textarea value={f.description} onChange={set("description")} /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="1 month ₹"><Input inputMode="decimal" value={f.price1m} onChange={set("price1m")} /></Field>
          <Field label="3 months ₹"><Input inputMode="decimal" value={f.price3m} onChange={set("price3m")} /></Field>
          <Field label="12 months ₹"><Input inputMode="decimal" value={f.price12m} onChange={set("price12m")} /></Field>
        </div>
        <p className="text-xs font-semibold text-muted-foreground">Court fee per player per hour (₹)</p>
        <div className="grid grid-cols-2 gap-2">
          {SPORTS.map((s) => (
            <Field key={s} label={s.charAt(0) + s.slice(1).toLowerCase()}>
              <Input inputMode="decimal" value={f[s]} onChange={set(s)} />
            </Field>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Social play fee ₹"><Input inputMode="decimal" value={f.socialFee} onChange={set("socialFee")} /></Field>
          <Field label="Advance booking days"><Input inputMode="numeric" value={f.days} onChange={set("days")} /></Field>
          <Field label="Shop discount %"><Input inputMode="numeric" value={f.shop} onChange={set("shop")} /></Field>
          <Field label="Bar discount %"><Input inputMode="numeric" value={f.bar} onChange={set("bar")} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.alcohol} onChange={(e) => setF({ ...f, alcohol: e.target.checked })} /> Alcohol allowed
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Plan on sale
        </label>
        <SaveBar
          onSave={async () => {
            const body = {
              name: f.name, description: f.description,
              price1m: fromRupeeText(f.price1m), price3m: fromRupeeText(f.price3m), price12m: fromRupeeText(f.price12m),
              socialFee: fromRupeeText(f.socialFee), shopDiscountPct: toInt(f.shop), barDiscountPct: toInt(f.bar), advanceBookingDays: toInt(f.days),
              alcoholAllowed: f.alcohol, active: f.active,
              courtFees: { TENNIS: fromRupeeText(f.TENNIS), CRICKET: fromRupeeText(f.CRICKET), PADEL: fromRupeeText(f.PADEL), BADMINTON: fromRupeeText(f.BADMINTON) },
            };
            assertNumbers({
              "1 month": body.price1m, "3 months": body.price3m, "12 months": body.price12m, "social fee": body.socialFee, "shop %": body.shopDiscountPct,
              "bar %": body.barDiscountPct, "booking days": body.advanceBookingDays, ...Object.fromEntries(Object.entries(body.courtFees).map(([k, v]) => [`${k} fee`, v])),
            });
            await api(`/api/plans/${plan.id}`, { method: "PATCH", body });
            onSaved();
          }}
        />
      </CardContent>
    </Card>
  );
}
