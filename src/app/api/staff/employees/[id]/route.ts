import { route } from "@/server/http";
import { employeeDetail } from "@/server/services/staff";

export const GET = route<{ id: string }>(async ({ actor, params }) => employeeDetail(actor, params.id));
