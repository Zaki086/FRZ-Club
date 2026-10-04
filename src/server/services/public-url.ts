// v6 URL-2: the club's configured public address, shown in Settings, and whether production would accept it.
import { appUrlProblem, appUrlProblemText, publicOrigin } from "@/lib/url";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";

export type PublicUrlStatus = { url: string; ok: boolean; reason: string };

export function publicUrlStatus(actor: Actor): PublicUrlStatus {
  assertCan(actor, "settings");
  const problem = appUrlProblem(process.env.APP_URL);
  return {
    url: publicOrigin(),
    ok: !problem,
    reason: problem
      ? `${appUrlProblemText(problem)}. Production refuses to start until APP_URL in .env is the club's public https:// address.`
      : "Every link in messages, emails, push notifications, QR codes and link previews uses this address.",
  };
}
