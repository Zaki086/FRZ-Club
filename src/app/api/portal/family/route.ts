import { route } from "@/server/http";
import { myFamily } from "@/server/services/family";

export const GET = route(async ({ actor }) => myFamily(actor));
