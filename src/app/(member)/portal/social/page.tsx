import { requireUser } from "@/server/auth/current";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { PortalSocial } from "./portal-social";

export default async function PortalSocialPage() {
  const actor = await requireUser(["MEMBER"]);
  return <PortalSocial memberId={actor.memberId!} today={istDate(clock.now())} />;
}
