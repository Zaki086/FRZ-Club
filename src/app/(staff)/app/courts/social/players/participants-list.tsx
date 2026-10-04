"use client";
// v3 §3.2: social play participants with the standard FilterBar and summary strip. The next action is on the row:
// take the fee, then check the player in (paid players only, from 30 minutes before the start — CI-2).
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { StatusBadge, TierBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { fmtDateTime, fmtRange } from "@/lib/time";
import { CheckInSocial, ParticipantBill } from "../social-board";
import { useNow } from "../../_components/use-now";

type Row = {
  id: string; session_id: string; title: string; start_at: string; end_at: string; session_status: string; status: string;
  name: string; phone: string | null; member_code: string | null; who: "member" | "guest"; tier: string; fee: number; bill_id: string | null;
  channel: string; checked_in_at: string | null; left_at: string | null; joined_at: string; paid: number; due: number; payment: string;
};
type Perms = { checkin: boolean; pay: boolean };

const STATUS_LABEL: Record<string, string> = { JOINED: "Joined", LEFT: "Left", CANCELLED_BY_CLUB: "Cancelled by club" };
const PAYMENT_LABEL: Record<string, string> = { UNPAID: "Unpaid", PARTIAL: "Part-paid", PAID: "Paid", FREE: "Nothing to pay", CLOSED: "Bill closed" };
const CHANNEL_LABEL: Record<string, string> = { FRONT_DESK: "front desk", ONLINE_MEMBER: "member portal", PHONE: "phone", MESSAGE: "message", WALK_IN: "walk-in", ONLINE_TRIAL: "trial" };

function NextAction({ r, perms }: { r: Row; perms: Perms }) {
  const reload = useListReload();
  const now = useNow();
  if (r.status !== "JOINED" || r.session_status !== "SCHEDULED") return null;
  if (r.due > 0 && r.bill_id && perms.pay) {
    return <span onClick={(e) => e.stopPropagation()}><ParticipantBill billId={r.bill_id} onPaid={reload} /></span>;
  }
  if (!r.checked_in_at && r.due === 0 && perms.checkin && new Date(r.end_at).getTime() > now) {
    return <span onClick={(e) => e.stopPropagation()}><CheckInSocial id={r.id} onDone={reload} /></span>;
  }
  return null;
}

export function ParticipantsList({ perms }: { perms: Perms }) {
  return (
    <FilteredList<Row>
      list="social-participants"
      searchPlaceholder="Name, phone, member code or session"
      pollMs={30_000}
      columns={[
        { key: "name", header: "Player", cell: (r) => (
          <span className="flex flex-col items-start gap-0.5">
            <span className="font-semibold">{r.name}</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">{r.who === "member" ? r.member_code ?? "Member" : "Guest"} <TierBadge tier={r.tier} /></span>
          </span>
        ) },
        { key: "session", header: "Session", cell: (r) => (
          <span className="flex flex-col">
            <span className="text-sm font-semibold">{r.title}</span>
            <span className="text-xs text-muted-foreground"><RelTime when={r.start_at} /> · {fmtRange(r.start_at, r.end_at)}</span>
          </span>
        ) },
        { key: "fee", header: "Fee", className: "text-right", cell: (r) => <Money paise={r.fee} /> },
        { key: "payment", header: "Payment", cell: (r) => (
          <span className="flex flex-col items-start gap-0.5">
            <StatusBadge status={r.payment === "CLOSED" || r.payment === "FREE" ? "DRAFT" : r.payment} label={PAYMENT_LABEL[r.payment] ?? r.payment} />
            {r.due > 0 ? <span className="text-xs font-semibold"><Money paise={r.due} /> due</span> : null}
          </span>
        ) },
        { key: "checkin", header: "Check-in", cell: (r) => (r.checked_in_at ? <span className="text-xs text-green-700">Checked in <RelTime when={r.checked_in_at} /></span> : <span className="text-muted-foreground">—</span>) },
        { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /> },
        { key: "next", header: "Next", cell: (r) => <NextAction r={r} perms={perms} /> },
      ]}
      rowExtra={(r) => (
        <p className="text-sm text-muted-foreground">
          Joined {fmtDateTime(r.joined_at)} via {CHANNEL_LABEL[r.channel] ?? r.channel.toLowerCase()}
          {r.phone ? ` · ${r.phone}` : ""}
          {r.paid ? <> · paid <Money paise={r.paid} /></> : null}
          {r.left_at ? ` · ${r.status === "CANCELLED_BY_CLUB" ? "cancelled by the club" : "left"} ${fmtDateTime(r.left_at)}` : ""}
          {r.session_status !== "SCHEDULED" ? ` · session ${r.session_status.toLowerCase()}` : ""}
        </p>
      )}
      empty={{ title: "No players match these filters" }}
    />
  );
}
