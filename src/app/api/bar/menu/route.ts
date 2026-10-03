import { z } from "zod";
import { body, query, route } from "@/server/http";
import { createMenuItem, listMenu, menuItemSchema } from "@/server/services/bar";

export const GET = route(async ({ req }) => listMenu({ includeUnavailable: query(req, z.object({ all: z.string().optional() })).all === "1" }), { auth: "optional" });

export const POST = route(async ({ req, actor }) => createMenuItem(actor, await body(req, menuItemSchema)));
