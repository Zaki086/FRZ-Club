// v5 §3.1: the variables each context may use (MT-1).
import { route } from "@/server/http";
import { variablesFor } from "@/server/services/messages/templates";

export const GET = route(async ({ actor }) => variablesFor(actor));
