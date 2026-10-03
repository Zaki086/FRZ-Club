import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { clock } from "@/lib/clock";
import { istDate, weekStart } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { RosterBoard } from "./roster-board";

export default async function RosterPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "roster.manage")) forbidden();
  const sp = await searchParams;
  return (
    <div>
      <PageHeader title="Staff roster" subtitle="Shifts for every role. No overlapping shifts and none during approved leave — the database enforces it." />
      <RosterBoard initialFrom={weekStart(istDate(clock.now()))} initialTab={sp.tab === "attendance" ? "attendance" : "roster"} />
    </div>
  );
}
