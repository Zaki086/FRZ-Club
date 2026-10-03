import { requireUser } from "@/server/auth/current";
import { MyBookings } from "./my-bookings";

export default async function PortalBookingsPage() {
  const actor = await requireUser(["MEMBER"]);
  return <MyBookings memberId={actor.memberId!} />;
}
