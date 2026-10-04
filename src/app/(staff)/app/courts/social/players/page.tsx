import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { ParticipantsList } from "./participants-list";

export const metadata: Metadata = { title: "Social players" };

export default async function SocialPlayersPage() {
  const actor = await requireUser();
  if (!can(actor, "courts.view")) forbidden();
  return (
    <div>
      <PageHeader
        title="Social players"
        actions={<Button asChild variant="outline"><Link href="/app/courts/social">Sessions</Link></Button>}
      />
      <ParticipantsList perms={{ checkin: can(actor, "checkin"), pay: can(actor, "bookings.any") }} />
    </div>
  );
}
