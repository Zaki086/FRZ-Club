import { z } from "zod";
import { body, query, route } from "@/server/http";
import { listMyNotifications, markNotificationsRead } from "@/server/services/notifications";

export const GET = route(async ({ req, actor }) => {
  const q = query(req, z.object({ unread: z.string().optional(), limit: z.coerce.number().optional() }));
  return listMyNotifications(actor, { unreadOnly: q.unread === "1", limit: q.limit });
});

export const POST = route(async ({ req, actor }) => {
  const input = await body(req, z.object({ ids: z.union([z.array(z.string()), z.literal("all")]) }));
  return markNotificationsRead(actor, input.ids);
});
