import { route } from "@/server/http";
import { drawerPayments } from "@/server/services/drawers";

export const GET = route<{ id: string }>(async ({ req, actor, params }) => drawerPayments(actor, params.id, req.nextUrl.searchParams.get("method") ?? ""));
