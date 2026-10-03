import { requireUser } from "@/server/auth/current";
import { PriceNotes } from "@/components/price-notes";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { PortalBook } from "./portal-book";

export default async function PortalBookPage() {
  const actor = await requireUser(["MEMBER"]);
  return (
    <div className="flex flex-col gap-3">
      <PriceNotes scopes={["COURTS"]} />
      <PortalBook memberId={actor.memberId!} memberName={actor.name} today={istDate(clock.now())} />
    </div>
  );
}
