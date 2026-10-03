import { route } from "@/server/http";
import { myStatus } from "@/server/services/staff";

export const GET = route(async ({ actor }) => myStatus(actor));
