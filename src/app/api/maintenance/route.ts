import { body, route } from "@/server/http";
import { createMaintenance, maintenanceSchema } from "@/server/services/booking";

export const POST = route(async ({ req, actor }) => createMaintenance(actor, await body(req, maintenanceSchema)));
