import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { BookingsList } from "./bookings-list";

export default async function BookingsPage() {
  const actor = await requireUser();
  if (!can(actor, "courts.view")) forbidden();
  return (
    <div>
      <PageHeader title="Bookings" subtitle="Open a booking to check players in, take payment, change players or cancel." />
      <BookingsList initialDate={istDate(clock.now())} perms={{ book: can(actor, "bookings.any"), checkin: can(actor, "checkin") }} />
    </div>
  );
}
