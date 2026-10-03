import { requireUser } from "@/server/auth/current";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { PortalBook } from "./portal-book";

export default async function PortalBookPage() {
  const actor = await requireUser(["MEMBER"]);
  return <PortalBook memberId={actor.memberId!} memberName={actor.name} today={istDate(clock.now())} />;
}
