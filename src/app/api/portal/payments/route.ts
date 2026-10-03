import { route } from "@/server/http";
import { myPayments } from "@/server/services/refunds";

export const GET = route(async ({ actor }) => myPayments(actor));
