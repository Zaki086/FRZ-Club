import { requireUser } from "@/server/auth/current";
import { MembershipSelfService } from "./membership-self-service";

export default async function PortalMembershipPage() {
  const actor = await requireUser(["MEMBER"]);
  return <MembershipSelfService memberId={actor.memberId!} />;
}
