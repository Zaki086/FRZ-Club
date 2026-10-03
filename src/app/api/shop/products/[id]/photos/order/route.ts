import { z } from "zod";
import { body, route } from "@/server/http";
import { reorderProductPhotos } from "@/server/services/products";

export const PUT = route<{ id: string }>(async ({ req, actor, params }) => reorderProductPhotos(actor, params.id, (await body(req, z.object({ ids: z.array(z.string()).max(5) }))).ids));
