import { body, route } from "@/server/http";
import { createTrialBooking, trialSchema } from "@/server/services/crm";

export const POST = route(async ({ req }) => createTrialBooking(await body(req, trialSchema)), { auth: "optional" });
