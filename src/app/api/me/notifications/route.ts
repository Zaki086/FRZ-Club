import { body, route } from "@/server/http";
import { myNotificationSettings, preferencesSchema, setMyPreferences } from "@/server/services/channels";

export const GET = route(async ({ actor }) => myNotificationSettings(actor));
export const PUT = route(async ({ req, actor }) => setMyPreferences(actor, await body(req, preferencesSchema)));
