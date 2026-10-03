import { body, route } from "@/server/http";
import { createPurchaseOrder, listPurchaseOrders, poSchema } from "@/server/services/purchasing";

export const GET = route(async ({ actor }) => listPurchaseOrders(actor));
export const POST = route(async ({ req, actor }) => createPurchaseOrder(actor, await body(req, poSchema)));
