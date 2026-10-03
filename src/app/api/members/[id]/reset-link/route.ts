import { route } from "@/server/http";
import { createResetLinkForMember } from "@/server/auth/account";

export const POST = route<{ id: string }>(async ({ actor, params }) => createResetLinkForMember(actor, params.id));
