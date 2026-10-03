import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { BarDay } from "./bar-day";

export default async function BarDayPage() {
  const actor = await requireUser();
  if (!can(actor, "bar.report")) forbidden();
  return (
    <div>
      <PageHeader title="Bar day" subtitle="What the bar earned, by method, category and staff. Close the day once every tab is settled or carried over." />
      <BarDay today={istDate(clock.now())} perms={{ close: can(actor, "bar.close_day"), operate: can(actor, "bar.operate") }} />
    </div>
  );
}
