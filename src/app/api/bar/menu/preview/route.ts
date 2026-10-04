import { z } from "zod";
import { query, route } from "@/server/http";
import { PREVIEW_AS, previewMenu } from "@/server/services/menu";

/** MN-4: the menu exactly as a member of the chosen plan sees it now. */
export const GET = route(async ({ req, actor }) => previewMenu(actor, query(req, z.object({ as: z.enum(PREVIEW_AS).default("SILVER") })).as));
