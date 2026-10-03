import { z } from "zod";
import { body, route } from "@/server/http";
import { setProductImage } from "@/server/services/shop";

export const PUT = route<{ id: string }>(async ({ req, actor, params }) => setProductImage(actor, params.id, (await body(req, z.object({ url: z.string().nullable() }))).url));
