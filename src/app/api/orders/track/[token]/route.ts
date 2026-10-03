import { route } from "@/server/http";
import { getOrderByToken } from "@/server/services/shop";

export const GET = route<{ token: string }>(async ({ params }) => getOrderByToken(params.token), { auth: "optional" });
