import { z } from "zod";
import { body, query, route } from "@/server/http";
import { listMenu } from "@/server/services/bar";
import { addMenuItem, menuItemInputSchema } from "@/server/services/menu";

/** The bar item grid / public list: ACTIVE items of active categories (available ones unless `all=1`). */
export const GET = route(async ({ req }) => listMenu({ includeUnavailable: query(req, z.object({ all: z.string().optional() })).all === "1" }), { auth: "optional" });

/** v5 §1.1: a new menu item (Menu screen; `menu.manage` + `menu.price`). */
export const POST = route(async ({ req, actor }) => addMenuItem(actor, await body(req, menuItemInputSchema)));
