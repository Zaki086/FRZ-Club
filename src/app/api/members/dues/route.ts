import { route } from "@/server/http";
import { listDues } from "@/server/services/members";

export const GET = route(async ({ actor }) => listDues(actor));
