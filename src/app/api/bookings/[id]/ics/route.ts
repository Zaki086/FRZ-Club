import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { getBooking } from "@/server/services/booking";
import { getSettings } from "@/server/services/settings";
import { icsEvent } from "@/lib/ics";

/** A booking as a calendar file (the member's own, or any for staff). */
export const GET = route<{ id: string }>(async ({ actor, params }) => {
  const b = await getBooking(actor, params.id);
  const club = (await getSettings()).club;
  const ics = icsEvent({
    uid: `${b.code}@${(process.env.APP_URL ?? "club").replace(/^https?:\/\//, "")}`,
    start: new Date(b.startAt), end: new Date(b.endAt),
    summary: `${b.court} · ${club.name || "Club"}`,
    description: `Booking ${b.code}. Players: ${b.players.map((p) => p.name).join(", ")}.`,
    location: club.address || undefined,
    cancelled: b.status === "CANCELLED",
  });
  return new NextResponse(ics, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="${b.code}.ics"` } });
});
