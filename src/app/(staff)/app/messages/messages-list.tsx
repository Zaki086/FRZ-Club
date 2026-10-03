"use client";
// v3 §6.3: the notification log with the standard FilterBar. Manual WhatsApp messages are opened in one click
// (wa.me with the text ready) and marked sent by the person who sent them — the app never claims it delivered them.
import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Row = {
  id: string; event: string; channel: string; status: string; created_at: string; title: string; body: string; error: string | null;
  to_address: string | null; member_id: string | null; member_name: string | null; member_code: string | null; recipient: string;
  trigger: string; triggered_by_name: string | null; handled_by_name: string | null;
};

const CHANNEL: Record<string, string> = { IN_APP: "In-app", PUSH: "Push", EMAIL: "Email", WHATSAPP_API: "WhatsApp (auto)", WHATSAPP_MANUAL: "WhatsApp (by hand)" };
const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" | "blue" }> = {
  SENT: { label: "Sent", tone: "green" }, DELIVERED: { label: "Delivered", tone: "green" }, QUEUED: { label: "To send", tone: "amber" },
  RETRYING: { label: "Retrying", tone: "amber" },
  LINK_OPENED: { label: "WhatsApp opened", tone: "blue" }, FAILED: { label: "Failed", tone: "red" }, SKIPPED: { label: "Not available", tone: "neutral" },
};

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
          const res = await api<{ url: string }>(`/api/messages/manual/${r.id}/open`, { body: {} });
          window.open(res.url, "_blank", "noopener");
        })}>Open WhatsApp</Button>
        <Button size="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/messages/manual/${r.id}/sent`, { body: {} }); })}>Mark sent</Button>
      </span>
      <RejectionBanner error={error} />
    </span>
  );
}

export function MessagesList({ canSend }: { canSend: boolean }) {
  return (
    <FilteredList<Row>
      list="notifications"
      searchPlaceholder="Name, member code, number or title"
      pollMs={30_000}
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
        { key: "next", header: "", cell: (r) => (canSend && r.channel === "WHATSAPP_MANUAL" && ["QUEUED", "LINK_OPENED"].includes(r.status) ? <ManualActions r={r} /> : null) },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-1 text-sm">
          <p className="whitespace-pre-line">{r.body}</p>
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
