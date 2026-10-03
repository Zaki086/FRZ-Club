import { requireUser } from "@/server/auth/current";
import { PushOptInCard } from "@/components/push-opt-in";
import { PortalHome } from "./portal-home";

export default async function PortalHomePage() {
  const actor = await requireUser(["MEMBER"]);
  // v4 §4.2: after login, a dismissible card offers push alerts (the browser prompt only follows a click).
  return (
    <div className="flex flex-col gap-4">
      <PushOptInCard />
      <PortalHome memberId={actor.memberId!} />
    </div>
  );
}
