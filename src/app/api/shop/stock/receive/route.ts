import { body, route } from "@/server/http";
import { receiveSchema, receiveStock } from "@/server/services/inventory";

export const POST = route(async ({ req, actor }) => receiveStock(actor, await body(req, receiveSchema)));
