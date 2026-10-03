import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { Member360 } from "./member-360";

export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "members.view")) forbidden();
  const { id } = await params;
  return (
    <Member360
      memberId={id}
      perms={{
        manage: can(actor, "members.manage"),
        cancel: can(actor, "membership.cancel"),
        checkin: can(actor, "checkin"),
        book: can(actor, "bookings.any"),
      }}
    />
  );
}
