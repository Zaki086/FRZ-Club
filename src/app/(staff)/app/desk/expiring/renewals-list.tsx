"use client";
// v3 §6.5 NT-3: members expiring soon, recently expired or with dues — who was notified, how, the status and the
// last contact — with the WhatsApp message one click away and "Renew now".
import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { Money } from "@/components/money";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { TierBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SendMessageButton } from "@/components/message-composer";
import { BulkSendButton } from "@/components/message-composer-bulk";
import { bulkTarget } from "@/components/message-composer-logic";

type Row = {
  id: string; code: string; name: string; phone: string; tier: string; status: string; ends_on: string | null; last_end: string | null;
  dues: number; last_contact_at: string | null; last_event: string | null; how: string | null; manual_id: string | null;
};

const CH: Record<string, string> = { PUSH: "Push", EMAIL: "Email", WHATSAPP_API: "WhatsApp", WHATSAPP_MANUAL: "WhatsApp (by hand)" };
const ST: Record<string, "green" | "amber" | "red" | "neutral" | "blue"> = { SENT: "green", DELIVERED: "green", QUEUED: "amber", LINK_OPENED: "blue", FAILED: "red" };

function How({ how }: { how: string | null }) {
  if (!how) return <span className="text-sm text-muted-foreground">Not contacted yet</span>;
  const parts = how.split(",").map((p) => p.split(":")).filter(([, s]) => s !== "SKIPPED");
  if (!parts.length) return <span className="text-sm text-muted-foreground">In-app only</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {parts.map(([c, s]) => <Badge key={c} tone={ST[s] ?? "neutral"}>{CH[c] ?? c}: {s === "QUEUED" ? "to send" : s.toLowerCase().replace("_", " ")}</Badge>)}
    </span>
  );
}

function SendWhatsApp({ id }: { id: string }) {
  const reload = useListReload();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) }); } finally { setBusy(false); }
  };
  return (
    <span className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      {opened ? (
        <Button size="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/messages/manual/${id}/sent`, { body: {} }); reload(); })}>Mark sent</Button>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
          const r = await api<{ url: string }>(`/api/messages/manual/${id}/open`, { body: {} });
          window.open(r.url, "_blank", "noopener");
          setOpened(true);
        })}>WhatsApp</Button>
      )}
      <RejectionBanner error={error} />
    </span>
  );
}

/** v5 §3.3–3.4 `messaging`: "Send message" per row (compose), row selection + bulk send (bulk), bulk text edits (editText). */
export function RenewalsList({ canSend, canRenew, messaging }: { canSend: boolean; canRenew: boolean; messaging?: { compose: boolean; bulk: boolean; editText: boolean } }) {
  return (
    <FilteredList<Row>
      list="renewals"
      searchPlaceholder="Name, mobile or member code"
      // v5 §3.4: select rows (or all matching the filter) and send one message to them all.
      selection={messaging?.bulk ? { rowLabel: (r) => r.name, actions: (sel, clear) => <BulkSendButton list="renewals" target={{ ...bulkTarget(sel), count: sel.total }} onDone={clear} canEditText={messaging.editText} /> } : undefined}
      columns={[
        { key: "name", header: "Member", cell: (r) => (
          <span className="flex flex-col">
            <Link className="font-semibold text-primary hover:underline" href={`/app/members/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.name}</Link>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">{r.tier !== "WALK_IN" ? <TierBadge tier={r.tier} /> : null}<span className="font-mono">{r.code}</span></span>
          </span>
        ) },
        { key: "ends", header: "Ends", cell: (r) => (r.status === "EXPIRING" || r.status === "EXPIRED" ? <RelTime when={String(r.ends_on ?? r.last_end).slice(0, 10)} className="text-sm" /> : <span className="text-muted-foreground">—</span>) },
        { key: "dues", header: "Dues", className: "text-right", cell: (r) => (r.dues > 0 ? <Money paise={r.dues} className="font-semibold text-warning-text" /> : <span className="text-muted-foreground">—</span>) },
        { key: "how", header: "Told", cell: (r) => <How how={r.how} /> },
        { key: "last", header: "Last contact", cell: (r) => <RelTime when={r.last_contact_at} className="text-sm" /> },
        { key: "next", header: "Next", cell: (r) => (
          <span className="flex flex-wrap items-start gap-1">
            {canSend && r.manual_id ? <SendWhatsApp id={r.manual_id} /> : null}
            {messaging?.compose ? <SendMessageButton context="MEMBER" recordId={r.id} /> : null}
            {canRenew && (r.status === "EXPIRING" || r.status === "EXPIRED") ? <Button size="sm" asChild><Link href={`/app/members/${r.id}`} onClick={(e) => e.stopPropagation()}>Renew now</Link></Button> : null}
            {r.dues > 0 && !(r.status === "EXPIRING" || r.status === "EXPIRED") ? <Button size="sm" variant="outline" asChild><Link href={`/app/members/${r.id}`} onClick={(e) => e.stopPropagation()}>Collect</Link></Button> : null}
          </span>
        ) },
      ]}
      empty={{ title: "Nobody to renew or chase", hint: "Members expiring within 7 days, expired in the last 60 days or with money due appear here." }}
    />
  );
}
