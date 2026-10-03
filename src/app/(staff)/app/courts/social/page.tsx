import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { SocialBoard } from "./social-board";

export default async function SocialPage() {
  const actor = await requireUser();
  if (!can(actor, "courts.view")) forbidden();
  return (
    <div>
      <PageHeader title="Social play" subtitle="Many players share a court held by one social reservation, so no regular booking can overlap it (SP-4)." />
      <SocialBoard
        today={istDate(clock.now())}
        perms={{ manage: can(actor, "social.manage"), book: can(actor, "bookings.any"), checkin: can(actor, "checkin") }}
      />
    </div>
  );
}
