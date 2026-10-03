import { requireUser } from "@/server/auth/current";
import { PortalHome } from "./portal-home";

export default async function PortalHomePage() {
  const actor = await requireUser(["MEMBER"]);
  return <PortalHome memberId={actor.memberId!} />;
}
