import { z } from "zod";
import { query, route } from "@/server/http";
import { findSaleByReceipt } from "@/server/services/shop";

/** v6 WI-5: a counter sale by its receipt code (CS-…) or its scanned receipt QR (RC1.…). */
export const GET = route(async ({ req, actor }) => findSaleByReceipt(actor, query(req, z.object({ text: z.string().max(200) })).text));
