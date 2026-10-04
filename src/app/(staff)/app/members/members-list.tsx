"use client";
// v3 §3, §6.2: members with the standard FilterBar, a summary strip and the next action on each row.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { FilteredList } from "@/components/list/filtered-list";
import { BulkSendButton } from "@/components/message-composer-bulk";
import { bulkTarget } from "@/components/message-composer-logic";

type Row = {
  id: string; code: string; name: string; phone: string; email: string | null; tier: string; status: string; ends_on: string | null;
  dues: number; open_tab: boolean; junior: boolean; has_guardian: boolean; last_visit: string | null; sports: string[];
};

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" | "blue" }> = {
  ACTIVE: { label: "Active", tone: "green" }, EXPIRING: { label: "Expiring", tone: "amber" }, EXPIRED: { label: "Expired", tone: "red" },
  PENDING_PAYMENT: { label: "Pending payment", tone: "amber" }, SCHEDULED: { label: "Scheduled", tone: "blue" }, NONE: { label: "No plan", tone: "neutral" },
};

/** The one thing to do next for this member, if any. */
function NextAction({ r }: { r: Row }) {
  const href = `/app/members/${r.id}`;
  if (r.dues > 0) return <Link href={href} className="text-sm font-semibold text-primary underline">Collect <Money paise={r.dues} /></Link>;
  if (r.status === "PENDING_PAYMENT") return <Link href={href} className="text-sm font-semibold text-primary underline">Take payment</Link>;
  if (r.status === "EXPIRING" || r.status === "EXPIRED") return <Link href={href} className="text-sm font-semibold text-primary underline">Renew</Link>;
  return null;
}

/**
 * `openOnRowClick` (v6 DESK-1, the front desk's Check-in & Search Members): a row click opens the member instead of
 * expanding the row.
 */
export function MembersList({ canCreate, canBulkSend = false, canEditText = false, openOnRowClick = false }: { canCreate: boolean; canBulkSend?: boolean; canEditText?: boolean; openOnRowClick?: boolean }) {
  const router = useRouter();
  return (
    <FilteredList<Row>
      list="members"
      searchPlaceholder="Name, mobile or CC-000123"
      toolbar={canCreate ? <Button asChild><Link href="/app/members/new"><UserPlus className="h-4 w-4" /> New member</Link></Button> : null}
      selection={canBulkSend ? { rowLabel: (r) => r.name, actions: (sel, clear) => <BulkSendButton list="members" target={{ ...bulkTarget(sel), count: sel.total }} onDone={clear} canEditText={canEditText} /> } : undefined}
      columns={[
        { key: "name", header: "Member", cell: (r) => (
          <span className="flex flex-col">
            <Link className="font-semibold text-primary hover:underline" href={`/app/members/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link>
            <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
          </span>
        ) },
        { key: "plan", header: "Membership", cell: (r) => (
          <span className="flex flex-wrap items-center gap-1">
            {r.tier !== "WALK_IN" ? <TierBadge tier={r.tier} /> : null}
            <Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge>
          </span>
        ) },
        { key: "ends", header: "Ends", cell: (r) => <RelTime when={r.ends_on ? String(r.ends_on).slice(0, 10) : null} className="text-sm" /> },
        { key: "dues", header: "Dues", className: "text-right", cell: (r) => (r.dues > 0 ? <Money paise={r.dues} className="font-semibold text-warning-text" /> : <span className="text-muted-foreground">—</span>) },
        { key: "visit", header: "Last visit", cell: (r) => <RelTime when={r.last_visit} className="text-sm" /> },
        { key: "next", header: "Next", cell: (r) => <NextAction r={r} /> },
      ]}
      onRowClick={openOnRowClick ? (r) => router.push(`/app/members/${r.id}`) : undefined}
      rowExtra={(r) => (
        <div className="grid gap-1 text-sm sm:grid-cols-3">
          <span>{r.phone}{r.email ? ` · ${r.email}` : ""}</span>
          <span>{r.sports.length ? `Plays ${r.sports.map((s) => s.toLowerCase()).join(", ")}` : "No court bookings yet"}{r.open_tab ? " · open bar tab" : ""}</span>
          <span>{r.junior ? (r.has_guardian ? "Junior · guardian on file" : "Junior · no guardian on file") : ""} <Link className="font-semibold text-primary underline" href={`/app/members/${r.id}`}>Open profile</Link></span>
        </div>
      )}
    />
  );
}
