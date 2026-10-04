"use client";
// v3 §6.3: the notification log with the standard FilterBar. Manual WhatsApp messages are opened in one click
// (wa.me with the text ready) and marked sent by the person who sent them — the app never claims it delivered them.
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SendNextPanel } from "@/components/message-composer-send-next";
import { SendAllButton, sendAllFilter } from "@/components/send-all";

type Row = {
  id: string; event: string; channel: string; status: string; created_at: string; title: string; body: string; error: string | null;
  to_address: string | null; member_id: string | null; member_name: string | null; member_code: string | null; recipient: string;
  trigger: string; triggered_by_name: string | null; handled_by_name: string | null;
  // v4 §5.4: automatic WhatsApp — template, tries and the status timeline.
  wa_template: string | null; attempts: number; urgent: boolean; sent_at: string | null; delivered_at: string | null; wa_read_at: string | null;
  failed_at: string | null; next_try_at: string | null;
};

const at = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Queued → sent → delivered → read (or failed), with times; the next try while a retry is waiting. */
export function DeliveryTimeline({ r }: { r: { created_at: string; sent_at: string | null; delivered_at: string | null; wa_read_at?: string | null; read_at?: string | null; failed_at: string | null; next_try_at: string | null; attempts: number } }) {
  const steps: Array<[string, string | null | undefined]> = [
    ["Queued", r.created_at], ["Sent", r.sent_at], ["Delivered", r.delivered_at], ["Read", r.wa_read_at ?? r.read_at], ["Failed", r.failed_at],
  ];
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label="Status timeline">
      {steps.filter(([, t]) => !!t).map(([label, t], i) => (
        <li key={label} className="flex items-center gap-2">
          {i ? <span aria-hidden className="text-muted-foreground">→</span> : null}
          <span className={label === "Failed" ? "font-semibold text-destructive" : ""}>{label} {at(t!)}</span>
        </li>
      ))}
      {r.next_try_at ? <li className="text-muted-foreground">· next try {at(r.next_try_at)}</li> : null}
      {r.attempts > 0 ? <li className="text-muted-foreground">· {r.attempts} {r.attempts === 1 ? "try" : "tries"}</li> : null}
    </ol>
  );
}

const CHANNEL: Record<string, string> = { IN_APP: "In-app", PUSH: "Push", EMAIL: "Email", WHATSAPP_API: "WhatsApp (auto)", WHATSAPP_MANUAL: "WhatsApp (by hand)" };
const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" | "blue" }> = {
  SENT: { label: "Sent", tone: "green" }, DELIVERED: { label: "Delivered", tone: "green" }, QUEUED: { label: "To send", tone: "amber" },
  RETRYING: { label: "Retrying", tone: "amber" },
  LINK_OPENED: { label: "WhatsApp opened", tone: "blue" }, FAILED: { label: "Failed", tone: "red" }, SKIPPED: { label: "Not available", tone: "neutral" },
  // v6 §2 (SENDALL)
  SENT_AUTOMATICALLY: { label: "Sent automatically", tone: "green" }, SKIPPED_NOT_RELEVANT: { label: "No longer needed", tone: "neutral" },
  SKIPPED_DUPLICATE: { label: "Duplicate", tone: "neutral" }, EXPIRED: { label: "Expired", tone: "amber" },
};

/** v6 SA-5: "Send all" applies to the list's current filter (the URL the FilterBar keeps). */
function SendAllToolbar() {
  const qs = useSearchParams().toString();
  return <SendAllButton filter={sendAllFilter(qs)} />;
}

function ManualActions({ r }: { r: Row }) {
  const reload = useListReload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
      <span className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
          // v6 SA-3: an expired message is sent by hand only after a confirmation.
          const expired = r.status === "EXPIRED";
          if (expired && !window.confirm("This message is older than the age limit. Send it anyway?")) return;
          const res = await api<{ url: string }>(`/api/messages/manual/${r.id}/open`, { body: expired ? { confirmExpired: true } : {} });
          window.open(res.url, "_blank", "noopener");
        })}>{r.status === "EXPIRED" ? "Send anyway…" : "Open WhatsApp"}</Button>
        {r.status === "EXPIRED" ? null : (
          <Button size="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/messages/manual/${r.id}/sent`, { body: {} }); })}>Mark sent</Button>
        )}
      </span>
      <RejectionBanner error={error} />
    </span>
  );
}

export function MessagesList({ canSend, canSendAll = false }: { canSend: boolean; canSendAll?: boolean }) {
  return (
    <FilteredList<Row>
      list="notifications"
      searchPlaceholder="Name, member code, number or title"
      pollMs={30_000}
      // v5 §3.4: step through the WhatsApp messages to send by hand — open the next, send, mark sent, next.
      toolbar={canSend || canSendAll ? <>{canSendAll ? <SendAllToolbar /> : null}{canSend ? <SendNextPanel /> : null}</> : undefined}
      columns={[
        { key: "when", header: "When", cell: (r) => <RelTime when={r.created_at} className="text-sm" /> },
        { key: "who", header: "To", cell: (r) => (
          <span className="flex flex-col">
            {r.member_id ? <Link className="font-semibold text-primary hover:underline" href={`/app/members/${r.member_id}`} onClick={(e) => e.stopPropagation()}>{r.member_name ?? r.recipient}</Link> : <span className="font-semibold">{r.recipient}</span>}
            <span className="text-xs text-muted-foreground">{r.to_address ?? r.member_code ?? ""}</span>
          </span>
        ) },
        { key: "what", header: "Message", cell: (r) => <span className="text-sm">{r.title}</span> },
        { key: "channel", header: "Channel", cell: (r) => <span className="text-sm">{CHANNEL[r.channel] ?? r.channel}</span> },
        { key: "status", header: "Status", cell: (r) => {
          // A queued email/push that already failed once is waiting for its next try (the reason is in the tooltip).
          const st = r.status === "QUEUED" && r.error && r.channel !== "WHATSAPP_MANUAL" ? "RETRYING" : r.status;
          return <Badge tone={STATUS[st]?.tone ?? "neutral"} title={r.error ?? undefined}>{STATUS[st]?.label ?? r.status}</Badge>;
        } },
        { key: "next", header: "", cell: (r) => (canSend && r.channel === "WHATSAPP_MANUAL" && ["QUEUED", "LINK_OPENED", "EXPIRED"].includes(r.status) ? <ManualActions r={r} /> : null) },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-1 text-sm">
          <p className="whitespace-pre-line">{r.body}</p>
          {r.wa_template ? <p className="text-xs">WhatsApp template <span className="font-mono">{r.wa_template}</span></p> : null}
          {r.channel === "WHATSAPP_API" || r.channel === "PUSH" || r.channel === "EMAIL" ? <DeliveryTimeline r={r} /> : null}
          <p className="text-xs text-muted-foreground">
            {r.trigger === "system" ? "Sent by the system" : `Triggered by ${r.triggered_by_name ?? "staff"}`}
            {r.handled_by_name ? ` · sent by hand by ${r.handled_by_name}` : ""}
            {r.error ? ` · ${r.error}` : ""}
          </p>
        </div>
      )}
      empty={{ title: "No messages match these filters" }}
    />
  );
}
