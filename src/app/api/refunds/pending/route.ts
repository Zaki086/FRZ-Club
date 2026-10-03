import { route } from "@/server/http";
import { listPendingRefunds } from "@/server/services/payments";

export const GET = route(async ({ actor }) => listPendingRefunds(actor));
