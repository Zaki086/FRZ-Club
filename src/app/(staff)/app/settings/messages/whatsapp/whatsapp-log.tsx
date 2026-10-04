"use client";
// v4 §5.4 step 8: every automatic WhatsApp message with its template, the recipient (masked number), the status
// timeline (queued → sent → delivered → read, or failed, with times), the error and the number of tries. Messages
// that could not go automatically show why and whether the desk's manual task was sent.
import Link from "next/link";
import { FilteredList } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { Badge } from "@/components/ui/badge";
import { DeliveryTimeline } from "../../../messages/messages-list";

type Row = {
  id: string; event: string; wa_template: string; status: string; wa_status: string | null; attempts: number; error: string | null; wa_error_code: number | null;
  title: string; body: string; queued_at: string; sent_at: string | null; delivered_at: string | null; read_at: string | null; failed_at: string | null;
  next_try_at: string | null; recipient_phone: string | null; recipient: string | null; member_id: string | null; member_code: string | null; manual_status: string | null;
};

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" | "blue" }> = {
  QUEUED: { label: "Queued", tone: "amber" }, RETRYING: { label: "Retrying", tone: "amber" }, SENT: { label: "Sent", tone: "blue" },
  DELIVERED: { label: "Delivered", tone: "green" }, READ: { label: "Read", tone: "green" }, FAILED: { label: "Failed", tone: "red" },
  NOT_AUTOMATIC: { label: "Not automatic", tone: "neutral" },
};

function statusOf(r: Row) {
  if (r.status === "FAILED") return "FAILED";
  if (r.status === "SKIPPED") return "NOT_AUTOMATIC";
  if (r.wa_status === "read") return "READ";
  if (r.status === "DELIVERED") return "DELIVERED";
  if (r.status === "SENT") return "SENT";
  return r.attempts > 0 ? "RETRYING" : "QUEUED";
}

const MANUAL: Record<string, string> = { QUEUED: "waiting in Messages to send", LINK_OPENED: "opened in WhatsApp by the desk", SENT: "sent by hand by the desk", SKIPPED: "not needed" };

export function WhatsAppLogView() {
  return (
    <FilteredList<Row>
      list="whatsapp-log"
      searchPlaceholder="Name, member code, last 4 digits or title"
      pollMs={30_000}
      columns={[
        { key: "when", header: "Queued", cell: (r) => <RelTime when={r.queued_at} className="whitespace-nowrap text-xs" /> },
        { key: "to", header: "To", cell: (r) => (
          <span className="flex flex-col">
            {r.member_id ? <Link className="font-semibold text-primary hover:underline" href={`/app/members/${r.member_id}`} onClick={(e) => e.stopPropagation()}>{r.recipient ?? "Member"}</Link> : <span className="font-semibold">{r.recipient ?? "—"}</span>}
            <span className="font-mono text-xs text-muted-foreground">{r.recipient_phone ?? ""}</span>
          </span>
        ) },
        { key: "template", header: "Template", cell: (r) => <span className="font-mono text-xs">{r.wa_template}</span> },
        { key: "status", header: "Status", cell: (r) => {
          const st = STATUS[statusOf(r)];
          return <Badge tone={st.tone} title={r.error ?? undefined}>{st.label}</Badge>;
        } },
        { key: "tries", header: "Tries", className: "text-right", cell: (r) => <span className="text-xs tabular-nums">{r.attempts}</span> },
      ]}
      rowExtra={(r) => (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-semibold">{r.title}</p>
          <DeliveryTimeline r={{ ...r, created_at: r.queued_at }} />
          {r.error ? <p className="text-xs text-destructive">{statusOf(r) === "NOT_AUTOMATIC" ? "Why: " : "Error: "}{r.error}{r.wa_error_code != null && !r.error.includes(`#${r.wa_error_code}`) ? ` (#${r.wa_error_code})` : ""}</p> : null}
          {r.manual_status && r.manual_status !== "SKIPPED" ? <p className="text-xs text-muted-foreground">Manual WhatsApp task: {MANUAL[r.manual_status] ?? r.manual_status.toLowerCase()}.</p> : null}
        </div>
      )}
      empty={{ title: "No WhatsApp messages for these filters" }}
    />
  );
}
