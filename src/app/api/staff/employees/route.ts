import { route } from "@/server/http";
import { listEmployees } from "@/server/services/staff";

export const GET = route(async ({ actor }) => listEmployees(actor));
