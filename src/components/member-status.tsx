import { fmtDate } from "@/lib/time";
import { Badge } from "./ui/badge";
import { TierBadge } from "./badges";

export type MemberStatus = { tier: string; status: "ACTIVE" | "EXPIRED" | "NONE"; endDate: string | null; daysLeft: number | null; badge: "green" | "amber" | "red" | "neutral" };

/** CI-1: green active / amber ≤ 7 days / red EXPIRED. Values come from the server. */
export function MemberStatusBadge({ status }: { status: MemberStatus }) {
  if (status.status === "EXPIRED") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <Badge tone="red" className="uppercase">Expired</Badge>
        {status.endDate ? <span className="text-xs text-muted-foreground">on {fmtDate(status.endDate)}</span> : null}
      </span>
    );
  }
  if (status.status === "NONE") return <Badge tone="neutral">No membership</Badge>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <TierBadge tier={status.tier} />
      <Badge tone={status.badge === "amber" ? "amber" : "green"}>
        {status.badge === "amber" ? `Expires in ${status.daysLeft} day${status.daysLeft === 1 ? "" : "s"}` : `Active to ${fmtDate(status.endDate!)}`}
      </Badge>
    </span>
  );
}
