import { route } from "@/server/http";
import { getSharedReport } from "@/server/services/reports";

export const GET = route<{ token: string }>(async ({ params }) => getSharedReport(params.token), { auth: "optional" });
