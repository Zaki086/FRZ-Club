// v4 §2 test helper: give a staff member's drawer a float (close the world's empty drawer, open again with cash).
// Since CD-4 / RF-9, change and cash refunds come only from cash that is already in the drawer.
import type { UserActor } from "@/server/rbac/actor";
import { closeDrawer, myDrawer, openDrawer } from "@/server/services/drawers";

export async function withFloat(actor: UserActor, openingFloat: number, area: "DESK" | "SHOP" | "BAR" = "DESK") {
  const d = await myDrawer(actor);
  if (d.open) await closeDrawer(actor, { cashCounted: d.open.cashExpected });
  return openDrawer(actor, { area, openingFloat });
}
