import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { KitchenDisplay } from "./kitchen-display";

export default async function KdsPage() {
  const actor = await requireUser();
  if (!can(actor, "bar.kds")) forbidden();
  return <KitchenDisplay />;
}
