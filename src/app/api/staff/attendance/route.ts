import { z } from "zod";
import { query, route } from "@/server/http";
import { listAttendance } from "@/server/services/staff";

export const GET = route(async ({ req, actor }) => listAttendance(actor, query(req, z.object({ from: z.string().optional(), to: z.string().optional() }))));
