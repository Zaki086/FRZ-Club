import { body, route } from "@/server/http";
import { member360 } from "@/server/services/members";
import { updateMember, updateMemberSchema } from "@/server/services/membership";

export const GET = route<{ id: string }>(async ({ actor, params }) => member360(actor, params.id));

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateMember(actor, params.id, await body(req, updateMemberSchema)));
