import { route } from "@/server/http";
import { listTables } from "@/server/services/bar";

export const GET = route(async ({ actor }) => listTables(actor));
