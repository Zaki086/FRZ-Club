import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { clock } from "@/lib/clock";
import { istDate, weekStart } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { RosterBoard } from "./roster-board";

export default async function RosterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireUser();
  if (!can(actor, "roster.manage")) forbidden();
  const sp = await searchParams;
  // `?tab=attendance` (linked from cash-variance notifications) opens that tab; list filters in the URL open the List tab.
  const initialTab = sp.tab === "attendance" ? "attendance" : Object.keys(sp).some((k) => k !== "tab") ? "list" : "roster";
  return (
    <div>
      <PageHeader title="Staff roster" />
      <RosterBoard initialFrom={weekStart(istDate(clock.now()))} initialTab={initialTab} />
    </div>
  );
}
