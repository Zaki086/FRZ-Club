import { body, route } from "@/server/http";
import { createEnquiry, leadSchema } from "@/server/services/crm";

export const POST = route(async ({ req }) => createEnquiry(await body(req, leadSchema)), { auth: "optional" });
