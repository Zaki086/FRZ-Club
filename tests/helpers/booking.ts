import { createBooking, type CreateBookingInput } from "@/server/services/booking";
import type { Actor } from "@/server/rbac/actor";
import type { World } from "./world";

export function book(
  w: World,
  opts: { court?: string; date?: string; time: string; players: CreateBookingInput["players"]; actor?: Actor; channel?: CreateBookingInput["channel"]; payment?: CreateBookingInput["payment"] },
  key?: string,
) {
  return createBooking(
    opts.actor ?? w.actors.FRONT_DESK,
    {
      courtId: w.courts[opts.court ?? "Court 1"].id,
      date: opts.date ?? "2026-10-12",
      startTime: opts.time,
      players: opts.players,
      channel: opts.channel ?? "FRONT_DESK",
      payment: opts.payment,
    },
    key,
  );
}

export const guest = (name: string) => ({ guest: { name } });
