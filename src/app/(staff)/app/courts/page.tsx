import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { CommandCentre } from "./_components/command-centre";

export default async function CourtsPage({ searchParams }: { searchParams: Promise<{ member?: string; date?: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "courts.view")) forbidden();
  const sp = await searchParams;
  const today = istDate(clock.now());
  return (
    <div>
      <PageHeader title="Court command centre" subtitle="Live view of every court. Click a free slot to book, a booking to check in, take payment, change players or cancel." />
      <CommandCentre
        initialDate={sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today}
        prefillMemberId={sp.member ?? null}
        perms={{ book: can(actor, "bookings.any"), maintenance: can(actor, "maintenance.manage"), checkin: can(actor, "checkin") }}
      />
    </div>
  );
}
