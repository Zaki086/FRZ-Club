import { z } from "zod";
import { body, route } from "@/server/http";
import { findCollectableRefunds } from "@/server/services/refunds";

/** RF-9 step 1: a scanned refund QR or member card, or a search by name, phone, member/refund/booking code. */
export const POST = route(async ({ req, actor }) => findCollectableRefunds(actor, (await body(req, z.object({ text: z.string().max(200) }))).text));
