import { z } from "zod";
import { body, query, route } from "@/server/http";
import { leaveSchema, listLeave, requestLeave } from "@/server/services/staff";

export const GET = route(async ({ req, actor }) => listLeave(actor, query(req, z.object({ status: z.string().optional() }))));

export const POST = route(async ({ req, actor }) => requestLeave(actor, await body(req, leaveSchema)));
