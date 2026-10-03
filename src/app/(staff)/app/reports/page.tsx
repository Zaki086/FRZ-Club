import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { getSettings } from "@/server/services/settings";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "Reports & sharing" };

export default async function ReportsPage() {
  const actor = await requireUser();
  if (!(can(actor, "dashboard.full") || can(actor, "dashboard.finance") || can(actor, "dashboard.ops"))) forbidden();
  const s = await getSettings();
  return (
    <ReportsView
      today={istDate(clock.now())}
      clubName={s.club.name}
      perms={{ ledger: can(actor, "finance.reports"), gst: can(actor, "gst"), share: can(actor, "share_links") }}
    />
  );
}
