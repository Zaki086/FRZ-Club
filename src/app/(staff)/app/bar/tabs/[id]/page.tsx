import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { ClockInBanner } from "../../_components/clock-in-banner";
import { TabScreen } from "./tab-screen";

export default async function TabPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "bar.operate")) forbidden();
  const { id } = await params;
  return (
    <div>
      <ClockInBanner />
      <TabScreen tabId={id} perms={{ manager: can(actor, "bar.close_day") }} />
    </div>
  );
}
