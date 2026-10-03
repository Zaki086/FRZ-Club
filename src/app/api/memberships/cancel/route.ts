import { body, route } from "@/server/http";
import { cancelMembership, cancelMembershipSchema } from "@/server/services/membership";

export const POST = route(async ({ req, actor }) => cancelMembership(actor, await body(req, cancelMembershipSchema)));
