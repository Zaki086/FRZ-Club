import { route } from "@/server/http";
import { credentialsStatus, reissueCredentials } from "@/server/services/membership";

/** v3 WK-5: the credentials panel; WK-6: reissue the one-time link (the old one stops working). */
export const GET = route<{ id: string }>(async ({ actor, params }) => credentialsStatus(actor, params.id));
export const POST = route<{ id: string }>(async ({ actor, params }) => reissueCredentials(actor, params.id));
