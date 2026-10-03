import { route } from "@/server/http";
import { createResetLink } from "@/server/auth/account";

export const POST = route<{ id: string }>(async ({ actor, params }) => createResetLink(actor, params.id));
