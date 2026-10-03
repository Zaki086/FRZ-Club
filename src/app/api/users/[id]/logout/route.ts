import { route } from "@/server/http";
import { forceLogout } from "@/server/services/users";

// v4 §1.2 Employees: force logout — every session of that staff member ends now.
export const POST = route<{ id: string }>(async ({ actor, params }) => forceLogout(actor, params.id));
