import { body, route } from "@/server/http";
import { clientSchema, createClient, listClients } from "@/server/services/invoices";

export const GET = route(async ({ actor }) => listClients(actor));

export const POST = route(async ({ req, actor }) => createClient(actor, await body(req, clientSchema)));
