import { body, route } from "@/server/http";
import { listMyPushDevices, pushSubscriptionSchema, subscribePush } from "@/server/services/channels";

// v4 §4.2: this browser's push subscription for the logged-in person (POST), and their devices (GET).
export const GET = route(async ({ actor }) => listMyPushDevices(actor));
export const POST = route(async ({ req, actor }) => subscribePush(actor, await body(req, pushSubscriptionSchema)));
