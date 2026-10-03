import { body, route } from "@/server/http";
import { createStaff, createStaffSchema, listUsers } from "@/server/services/users";

export const GET = route(async ({ actor }) => listUsers(actor));

export const POST = route(async ({ req, actor }) => createStaff(actor, await body(req, createStaffSchema)));
