import { route } from "@/server/http";
import { listApprovals } from "@/server/services/approvals";

// v4 RN-4: the "Needs your approval" rows for the signed-in Owner / Manager.
export const GET = route(async ({ actor }) => listApprovals(actor));
