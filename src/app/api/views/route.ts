import { z } from "zod";
import { body, query, route } from "@/server/http";
import { listSavedViews, saveView, savedViewSchema } from "@/server/services/saved-views";

export const GET = route(async ({ req, actor }) => listSavedViews(actor, query(req, z.object({ list: z.string() })).list));
export const POST = route(async ({ req, actor }) => saveView(actor, await body(req, savedViewSchema)));
