import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { getSettings } from "@/server/services/settings";
import { listPlans } from "@/server/services/plans";
import { formatINR } from "@/lib/money";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TierBadge } from "@/components/badges";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export const metadata: Metadata = { title: "Plans & prices" };
export const dynamic = "force-dynamic";

const fee = (paise: number) => (paise === 0 ? "Free" : formatINR(paise));
const SPORTS = ["TENNIS", "CRICKET"] as const;
const SPORT_LABEL: Record<string, string> = { TENNIS: "Tennis", CRICKET: "Cricket nets" };

export default async function PlansPage() {
  const [s, plans] = await Promise.all([getSettings(), listPlans({ activeOnly: true })]);
  const w = s.walk_in;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold">Plans &amp; prices</h1>
        <p className="text-muted-foreground">All prices include GST. Your plan&apos;s rates and discounts apply automatically at the courts, the shop and the bar.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => (
          <Card key={p.id} className={p.code === "GOLD" ? "ring-2 ring-yellow-400" : undefined}>
            <CardHeader>
              <TierBadge tier={p.code} />
              <p className="mt-2 text-3xl font-bold">{formatINR(p.price1m)}<span className="text-base font-normal text-muted-foreground"> / month</span></p>
              <p className="text-sm text-muted-foreground">{formatINR(p.price3m)} for 3 months · {formatINR(p.price12m)} for 12 months</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm">{p.description}</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                {SPORTS.map((sp) => {
                  const f = p.courtFees.find((x) => x.sport === sp)?.fee;
                  return f === undefined ? null : <li key={sp} className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" />{SPORT_LABEL[sp]}: {f === 0 ? "free" : `${formatINR(f)} per player per hour`}</li>;
                })}
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" />Social play: {p.socialFee === 0 ? "free" : formatINR(p.socialFee)}</li>
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" />{p.shopDiscountPct}% off at the shop</li>
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" />{p.barDiscountPct}% off at the bar</li>
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-primary" />Book up to {p.advanceBookingDays} days ahead</li>
              </ul>
              {p.code === "JUNIOR" ? <p className="rounded-md bg-sky-50 p-2 text-xs text-sky-900">For players under 18 on the start date. No alcohol is served on Junior memberships.</p> : null}
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader><h2 className="text-xl font-bold">Compare with walk-in rates</h2><p className="text-sm text-muted-foreground">Without a membership (or when it has expired) these rates apply.</p></CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR><TH /><TH>Walk-in</TH>{plans.map((p) => <TH key={p.id}>{p.name}</TH>)}</TR>
            </THead>
            <TBody>
              {SPORTS.map((sp) => (
                <TR key={sp}>
                  <TD className="font-medium">{SPORT_LABEL[sp]} (per player per hour)</TD>
                  <TD>{fee(w.court_fee[sp])}</TD>
                  {plans.map((p) => <TD key={p.id}>{fee(p.courtFees.find((x) => x.sport === sp)?.fee ?? w.court_fee[sp])}</TD>)}
                </TR>
              ))}
              <TR><TD className="font-medium">Social play</TD><TD>{fee(w.social_fee)}</TD>{plans.map((p) => <TD key={p.id}>{fee(p.socialFee)}</TD>)}</TR>
              <TR><TD className="font-medium">Shop discount</TD><TD>{w.shop_discount_pct}%</TD>{plans.map((p) => <TD key={p.id}>{p.shopDiscountPct}%</TD>)}</TR>
              <TR><TD className="font-medium">Bar discount</TD><TD>{w.bar_discount_pct}%</TD>{plans.map((p) => <TD key={p.id}>{p.barDiscountPct}%</TD>)}</TR>
              <TR><TD className="font-medium">Advance booking</TD><TD>{w.advance_booking_days} day</TD>{plans.map((p) => <TD key={p.id}>{p.advanceBookingDays} days</TD>)}</TR>
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-3">
        <Button asChild size="lg"><Link href="/enquire">Enquire about membership</Link></Button>
        <Button asChild size="lg" variant="outline"><Link href="/trial">Book a trial session</Link></Button>
      </div>
    </div>
  );
}
