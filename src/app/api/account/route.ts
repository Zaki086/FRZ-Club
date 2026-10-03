import { body, route } from "@/server/http";
import { getProfile, profileSchema, updateProfile } from "@/server/auth/account";

export const GET = route(async ({ actor }) => getProfile(actor));
export const PUT = route(async ({ req, actor }) => updateProfile(actor, await body(req, profileSchema)));
