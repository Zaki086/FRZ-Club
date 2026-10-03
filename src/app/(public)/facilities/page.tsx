import type { Metadata } from "next";
import Link from "next/link";
import { Beer, Clock, ShoppingBag, Trophy } from "lucide-react";
import { getSettings } from "@/server/services/settings";
import { listCourts } from "@/server/services/courts";
import { getCapabilities } from "@/server/services/capabilities";
import { prisma } from "@/server/db";
import { clock } from "@/lib/clock";
import { istDate, istDayRange, istTime } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Facilities" };
export const dynamic = "force-dynamic";

const SPORT_LABEL: Record<string, string> = { TENNIS: "Tennis court", CRICKET: "Cricket net", PADEL: "Padel court", BADMINTON: "Badminton court" };

export default async function FacilitiesPage() {
  const [s, courts, caps] = await Promise.all([getSettings(), listCourts(), getCapabilities()]);
  // Completion pass §9: the badge comes from real maintenance blocks (now, or later today).
  const now = clock.now();
  const [, dayEnd] = istDayRange(istDate(now));
  const maintenance = await prisma.courtReservation.findMany({
    where: { kind: "MAINTENANCE", status: "ACTIVE", endAt: { gt: now }, startAt: { lt: dayEnd } },
    orderBy: { startAt: "asc" },
  });
  const badge = (courtId: string) => {
    const m = maintenance.find((x) => x.courtId === courtId);
    if (!m) return { tone: "green" as const, text: "Open" };
    if (m.startAt.getTime() <= now.getTime()) return { tone: "red" as const, text: `Maintenance until ${istTime(m.endAt)}` };
    return { tone: "amber" as const, text: `Maintenance ${istTime(m.startAt)}–${istTime(m.endAt)}` };
  };
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold">Facilities</h1>
        <p className="text-muted-foreground">Everything you need for a game and for afterwards.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" /> Opening hours</CardTitle></CardHeader>
        <CardContent><p>Every day, {s.opening_hours.open}–{s.opening_hours.close}. Sessions last one hour and a new one starts every half hour.</p></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Trophy className="h-5 w-5" /> Courts &amp; nets</CardTitle></CardHeader>
        <CardContent>
          {courts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No courts are open for booking right now.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {courts.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="font-semibold">{c.name}</p>
                    <p className="text-sm text-muted-foreground">{SPORT_LABEL[c.sport] ?? c.sport} · up to {c.maxPlayers} players</p>
                  </div>
                  <Badge tone={badge(c.id).tone} data-testid="court-status">{badge(c.id).text}</Badge>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild><Link href="/availability">See this week&apos;s availability</Link></Button>
            <Button asChild variant="outline"><Link href="/trial">Book a trial</Link></Button>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShoppingBag className="h-5 w-5" /> Gear shop</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <p>Rackets, balls, shoes, accessories and apparel. Order online and collect at the club{caps.delivery.enabled ? ", or have it delivered" : ""}. Broken string? We restring at the counter.</p>
            <Link href="/shop" className="mt-2 inline-block font-medium text-primary">Browse the shop</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Beer className="h-5 w-5" /> Bar &amp; cafeteria</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <p>Snacks, meals and drinks after your game. Run a tab and settle by cash, card or UPI before you leave. Members get their plan discount automatically; alcohol is served only to adults.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
