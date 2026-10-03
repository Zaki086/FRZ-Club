import { body, route } from "@/server/http";
import { depositSchema, recordDeposit } from "@/server/services/drawers";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => recordDeposit(actor, params.id, await body(req, depositSchema)));
