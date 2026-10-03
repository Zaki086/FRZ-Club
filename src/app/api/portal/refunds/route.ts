import { route } from "@/server/http";
import { myRefunds } from "@/server/services/refunds";

export const GET = route(async ({ actor }) => myRefunds(actor));
