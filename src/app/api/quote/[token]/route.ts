import { route } from "@/server/http";
import { getQuoteByToken } from "@/server/services/crm";

export const GET = route<{ token: string }>(async ({ params }) => getQuoteByToken(params.token), { auth: "optional" });
