import { z } from "zod";
import { query, route } from "@/server/http";
import { getAvailability, type Viewer } from "@/server/services/booking";
import { can } from "@/server/rbac/permissions";

// BK-12: staff see names; members and the public see only Booked / Social / Maintenance / Free.
export const GET = route(
  async ({ req, actor }) => {
    const q = query(req, z.object({ date: z.string(), days: z.coerce.number().int().min(1).max(14).default(1) }));
    const viewer: Viewer = can(actor, "courts.view") ? "STAFF" : actor.kind === "USER" ? "MEMBER" : "PUBLIC";
    return getAvailability(viewer, q.date, q.days);
  },
  { auth: "optional" },
);
