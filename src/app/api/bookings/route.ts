import { z } from "zod";
import { body, query, route } from "@/server/http";
import { createBooking, createBookingSchema, listBookings } from "@/server/services/booking";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, z.object({ date: z.string().optional(), status: z.string().optional(), courtId: z.string().optional(), q: z.string().optional() }));
  return listBookings(actor, { date: q.date, status: q.status || undefined, courtId: q.courtId || undefined, search: q.q });
});

export const POST = route(async ({ req, actor, idempotencyKey }) => createBooking(actor, await body(req, createBookingSchema), idempotencyKey));
