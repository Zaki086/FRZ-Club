import { body, route } from "@/server/http";
import { pushSubscriptionSchema, subscribePush } from "@/server/services/channels";

export const POST = route(async ({ req, actor }) => subscribePush(actor, await body(req, pushSubscriptionSchema)));
