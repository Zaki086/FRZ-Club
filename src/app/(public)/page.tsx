import Link from "next/link";
import { ArrowRight, Beer, CalendarCheck, MapPin, Phone, ShoppingBag, Trophy } from "lucide-react";
import { getSettings } from "@/server/services/settings";
import { getCapabilities } from "@/server/services/capabilities";
import { prisma } from "@/server/db";
import { clock } from "@/lib/clock";
import { listPlans } from "@/server/services/plans";
import { listCatalogue } from "@/server/services/shop";
import { listCourts } from "@/server/services/courts";
import { formatINR } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TierBadge } from "@/components/badges";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [s, plans, catalogue, courts, caps, socialSoon] = await Promise.all([
    getSettings(), listPlans({ activeOnly: true }), listCatalogue(), listCourts(), getCapabilities(),
    prisma.socialSession.count({ where: { status: "SCHEDULED", startAt: { gt: clock.now() } } }),
  ]);
  const tennis = courts.filter((c) => c.sport === "TENNIS").length;
  const cricket = courts.filter((c) => c.sport === "CRICKET").length;
  const teaser = catalogue.filter((p) => p.trackStock).slice(0, 4);
  return (
    <div>
      <section className="bg-gradient-to-br from-ink via-primary to-ink text-ink-foreground">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-14 sm:py-20">
          <p className="text-sm font-semibold uppercase tracking-widest text-accent">{s.club.address}</p>
          <h1 className="max-w-3xl text-4xl font-black leading-tight sm:text-5xl">{s.club.name}</h1>
          <p className="max-w-2xl text-lg text-ink-foreground/90">
            {tennis} tennis courts and {cricket} cricket nets you can book online, a gear shop for everything from strings to shoes, and a bar &amp; cafeteria for after the match.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg" className="bg-white text-success-text hover:bg-success/10">
              <Link href="/trial"><CalendarCheck className="h-5 w-5" /> Book a trial</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-white/60 bg-transparent text-white hover:bg-white/10">
              <Link href="/plans">See plans &amp; prices</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-white/60 bg-transparent text-white hover:bg-white/10">
              <Link href="/availability">Check availability</Link>
            </Button>
          </div>
          <p className="text-sm text-ink-foreground/80">Open every day {s.opening_hours.open}–{s.opening_hours.close}</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="mb-6 flex items-end justify-between gap-3">
          <h2 className="text-2xl font-bold">Membership plans</h2>
          <Link href="/plans" className="inline-flex items-center gap-1 text-sm font-medium text-primary">All details <ArrowRight className="h-4 w-4" /></Link>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((p) => {
            const fee = p.courtFees.find((f) => f.sport === "TENNIS")?.fee ?? 0;
            return (
              <Card key={p.id}>
                <CardContent className="flex flex-col gap-2 pt-5">
                  <TierBadge tier={p.code} />
                  <p className="text-3xl font-bold">{formatINR(p.price1m)}<span className="text-base font-normal text-muted-foreground"> / month</span></p>
                  <p className="text-sm text-muted-foreground">{p.description}</p>
                  <ul className="mt-1 text-sm">
                    <li>Courts: {fee === 0 ? "Free" : `${formatINR(fee)} per player per hour`}</li>
                    <li>{p.shopDiscountPct}% off at the shop · {p.barDiscountPct}% off at the bar</li>
                    <li>Book up to {p.advanceBookingDays} days ahead</li>
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="bg-muted/50">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-12 md:grid-cols-3">
          <Card><CardContent className="flex flex-col gap-2 pt-5"><Trophy className="h-6 w-6 text-primary" /><h3 className="font-semibold">Courts &amp; nets</h3><p className="text-sm text-muted-foreground">{courts.map((c) => c.name).join(", ")}. One-hour sessions starting every half hour{socialSoon ? ", plus social play sessions" : ""}.</p><Link href="/facilities" className="text-sm font-medium text-primary">Facilities</Link></CardContent></Card>
          <Card><CardContent className="flex flex-col gap-2 pt-5"><ShoppingBag className="h-6 w-6 text-primary" /><h3 className="font-semibold">Gear shop</h3><p className="text-sm text-muted-foreground">Rackets, balls, shoes, accessories and apparel — order online for pickup{caps.delivery.enabled ? " or delivery" : ""}, or get a racket restrung.</p><Link href="/shop" className="text-sm font-medium text-primary">Visit the shop</Link></CardContent></Card>
          <Card><CardContent className="flex flex-col gap-2 pt-5"><Beer className="h-6 w-6 text-primary" /><h3 className="font-semibold">Bar &amp; cafeteria</h3><p className="text-sm text-muted-foreground">Food and drinks after the match. Members get their plan discount automatically.</p></CardContent></Card>
        </div>
      </section>

      {teaser.length ? (
        <section className="mx-auto max-w-6xl px-4 py-12">
          <div className="mb-6 flex items-end justify-between gap-3">
            <h2 className="text-2xl font-bold">From the shop</h2>
            <Link href="/shop" className="inline-flex items-center gap-1 text-sm font-medium text-primary">Full catalogue <ArrowRight className="h-4 w-4" /></Link>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {teaser.map((p) => {
              const v = p.variants[0];
              return (
                <Link key={p.id} href={`/shop/${p.id}`} className="rounded-lg border bg-card p-4 hover:shadow-md">
                  <p className="text-xs uppercase text-muted-foreground">{p.brand}</p>
                  <p className="font-semibold">{p.name}</p>
                  <p className="mt-1 font-bold">{v.offerPrice !== null ? <><s className="mr-1 font-normal text-muted-foreground">{formatINR(v.price)}</s>{formatINR(v.offerPrice)}</> : formatINR(v.price)}</p>
                  <p className={`text-xs ${v.inStock ? "text-muted-foreground" : "text-destructive"}`}>{v.stockLabel}</p>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="mx-auto max-w-6xl px-4 pb-14">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-bold">How to reach us</h2>
              {s.club.address ? <p className="mt-1 flex items-center gap-2 text-sm"><MapPin className="h-4 w-4" /> {s.club.address}</p> : null}
              {s.club.phone || s.club.email ? <p className="flex items-center gap-2 text-sm"><Phone className="h-4 w-4" /> {[s.club.phone, s.club.email].filter(Boolean).join(" · ")}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild><Link href="/enquire">Send an enquiry</Link></Button>
              <Button asChild variant="outline"><Link href="/trial">Book a trial</Link></Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
