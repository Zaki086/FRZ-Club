import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { getSettings } from "@/server/services/settings";
import { Kiosk } from "./kiosk";

export const metadata: Metadata = { title: "Check-in kiosk" };
export const dynamic = "force-dynamic";

/**
 * Completion pass P2: self check-in at the entrance. A tablet signed in as the front desk opens /kiosk; members scan
 * their card and check themselves in for today's booking or social play (the same rules as the desk: paid, and
 * from 30 minutes before the start).
 */
export default async function KioskPage() {
  const actor = await requireUser(undefined, "/kiosk");
  if (!can(actor, "checkin")) forbidden();
  return <Kiosk clubName={(await getSettings()).club.name || "Welcome"} />;
}
