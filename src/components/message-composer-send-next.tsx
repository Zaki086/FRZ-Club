"use client";
// v5 §3.4: "Send next" in Messages to Send — step through the WhatsApp messages waiting to be sent by hand (single
// sends and bulk sends alike): open the next wa.me link (logged LINK_OPENED), send it from the club phone, mark it
// sent (logged SENT), then the next one is offered. The app never claims a message was sent before staff say so.
import { useState } from "react";
import { MessageCircle, SkipForward } from "lucide-react";
import { api, ApiError, useApi } from "./api";
import { useListReload } from "./list/filtered-list";
import { RejectionBanner } from "./states";
import { Button } from "./ui/button";
import { nextInQueue, openPopup, type QueueRow } from "./message-composer-logic";

/** The WhatsApp messages still to send by hand, oldest first (the same rows as the Messages to Send filter). */
export const SEND_QUEUE_URL = "/api/lists/notifications?channel=WHATSAPP_MANUAL&status=QUEUED%2CLINK_OPENED&sort=oldest&size=100";

type QueueData = { total: number; rows: QueueRow[] };

export function SendNextPanel() {
  const reloadList = useListReload();
  const queue = useApi<QueueData>(SEND_QUEUE_URL, { pollMs: 30_000 });
  const [current, setCurrent] = useState<QueueRow | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [sentCount, setSentCount] = useState(0);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const rows = queue.data?.rows ?? [];
  const next = nextInQueue(rows, skipped, current?.id ?? null);
  const left = (queue.data?.total ?? 0) - (current ? 1 : 0);
  if (!queue.data || (!current && !next && !sentCount)) return null;

  const refresh = async () => {
    await queue.reload();
    reloadList();
  };

  const open = async (row: QueueRow) => {
    setBusy(true);
    setError(null);
    // Open the tab inside the click so pop-up blockers allow it, then point it at wa.me.
    const w = openPopup();
    try {
      const r = await api<{ url: string }>(`/api/messages/manual/${row.id}/open`, { body: {} });
      if (w) w.location.href = r.url;
      else window.open(r.url, "_blank", "noopener");
      setCurrent(row);
      setLastSent(null);
    } catch (e) {
      w?.close();
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
      setSkipped((s) => [...s, row.id]);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const markSent = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/messages/manual/${current.id}/sent`, { body: {} });
      setSentCount((n) => n + 1);
      setLastSent(current.member_name ?? current.recipient);
      setCurrent(null);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2 rounded-2xl border border-primary/40 bg-primary/5 p-3 text-sm" data-testid="send-next">
      {current ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="send-next-current">
          <MessageCircle className="h-4 w-4 text-primary" />
          <span className="flex-1">
            WhatsApp opened for <span className="font-semibold">{current.member_name ?? current.recipient}</span>
            {current.to_address ? <span className="text-muted-foreground"> ({current.to_address})</span> : null}
            {" — "}{current.title}. Send it from the club phone, then mark it sent.
          </span>
          <Button size="sm" disabled={busy} onClick={markSent} data-testid="send-next-mark-sent">Mark as sent</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => open(current)}>Open again</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setSkipped((s) => [...s, current.id]); setCurrent(null); }}>
            <SkipForward className="h-4 w-4" /> Skip for now
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1">
            {lastSent ? <span className="font-semibold text-success-text">Marked sent: {lastSent}. </span> : null}
            {next ? (
              <><span className="font-semibold" data-testid="send-next-left">{left}</span> WhatsApp message{left === 1 ? "" : "s"} to send by hand. Next: <span className="font-semibold">{next.member_name ?? next.recipient}</span> — {next.title}</>
            ) : (
              <span data-testid="send-next-done">Nothing left to send{sentCount ? ` — ${sentCount} sent in this run` : ""}{skipped.length ? ` (${skipped.length} skipped for now)` : ""}.</span>
            )}
          </span>
          {next ? (
            <Button size="sm" disabled={busy} onClick={() => open(next)} data-testid="send-next-open">
              <MessageCircle className="h-4 w-4" /> Send next
            </Button>
          ) : null}
        </div>
      )}
      <RejectionBanner error={error} />
    </div>
  );
}
