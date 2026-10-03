import { body, route } from "@/server/http";
import { updateStaff, updateStaffSchema } from "@/server/services/users";

// v4 §1.2 Employees: the Owner changes a staff member's role, salary or join date.
export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateStaff(actor, params.id, await body(req, updateStaffSchema)));
