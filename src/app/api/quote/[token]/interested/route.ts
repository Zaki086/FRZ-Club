import { route } from "@/server/http";
import { markInterested } from "@/server/services/crm";

export const POST = route<{ token: string }>(async ({ params }) => markInterested(params.token), { auth: "optional" });
