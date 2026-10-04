// v4 §2 test helper: give a staff member's drawer a float (close the world's empty drawer, open again with cash).
// Since CD-4 / RF-9, change and cash refunds come only from cash that is already in the drawer.
import type { UserActor } from "@/server/rbac/actor";
import { closeDrawer, myDrawer, openDrawer } from "@/server/services/drawers";

// v6 TL-1: the drawer is opened at the actor's own area (shop staff → shop, bar staff → bar, accountant → office;
// everyone else the front desk) unless the test names one — a mismatched area is now DRAWER_AREA_MISMATCH.
const AREA_OF_ROLE: Partial<Record<UserActor["role"], "DESK" | "SHOP" | "BAR" | "OFFICE">> = { SHOP_STAFF: "SHOP", BAR_STAFF: "BAR", ACCOUNTANT: "OFFICE" };

export async function withFloat(actor: UserActor, openingFloat: number, area?: "DESK" | "SHOP" | "BAR" | "OFFICE") {
  const d = await myDrawer(actor);
  if (d.open) await closeDrawer(actor, { cashCounted: d.open.cashExpected });
  return openDrawer(actor, { area: area ?? AREA_OF_ROLE[actor.role] ?? "DESK", openingFloat });
}
