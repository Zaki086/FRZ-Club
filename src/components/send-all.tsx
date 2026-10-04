"use client";
// v6 §2.3 (SENDALL) "Send all" — on Messages to Send (applies to the current filter) and on the dashboard tile with the
// waiting messages. Opens the server-computed preflight (nothing is sent yet), then confirm → the job runs in the
// background with a live progress bar and a summary.
// SA-0: automatic WhatsApp only through the official WhatsApp Cloud API. This app never automates WhatsApp Web or
// Desktop or simulates clicks — without the API, WhatsApp simply isn't sent automatically (SA-9).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import { api, ApiError, useApi } from "./api";
import { useCapabilities } from "./capabilities";
import { InfoTip } from "./info-tip";
import { RejectionBanner } from "./states";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { SEND_ALL_API, type SendAllJob, type SendAllPreflight, type SendAllStartResponse } from "@/server/services/messages/send-all-contract";

type Err = { code?: string; message: string } | null;
const toErr = (e: unknown): Err => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

/** The Messages to Send filter of a list query string (or of the page URL): channel/status/paging are not part of it. */
export function sendAllFilter(qs: string): string {
  const p = new URLSearchParams(qs.replace(/^\?/, ""));
  for (const k of ["page", "size", "sort", "view", "channel", "status"]) p.delete(k);
  return p.toString();
}

export function SendAllButton({ filter, size = "sm", variant, testId = "send-all" }: { filter: string; size?: "sm" | "default"; variant?: "outline"; testId?: string }) {
  const caps = useCapabilities();
  const [open, setOpen] = useState(false);
  // SA-9: without the WhatsApp API the button says what it really does.
  const label = caps && !caps.whatsappApi ? "Send all by email & push" : "Send all";
  return (
    <>
      <Button size={size} variant={variant} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }} data-testid={testId}>
        <Send className="mr-1 h-4 w-4" aria-hidden />{label}
      </Button>
      {open ? <SendAllDialog filter={filter} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function Row({ label, value, testId, strong }: { label: React.ReactNode; value: React.ReactNode; testId?: string; strong?: boolean }) {
  return (
    <li className={`flex items-baseline justify-between gap-3 py-1 ${strong ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span className="tabular" data-testid={testId}>{value}</span>
    </li>
  );
}

function SendAllDialog({ filter, onClose }: { filter: string; onClose: () => void }) {
  const [useOther, setUseOther] = useState(true);
  const [pre, setPre] = useState<SendAllPreflight | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);

  const load = useCallback(async (other: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const p = await api<SendAllPreflight>(SEND_ALL_API.preflight, { body: { filter, useOtherChannels: other } });
      setPre(p);
      if (p.runningJob) setJobId(p.runningJob.id);
    } catch (e) {
      setError(toErr(e));
    } finally {
      setBusy(false);
    }
  }, [filter]);

  // The first preflight (state is set only in the request's callbacks).
  useEffect(() => {
    let alive = true;
    api<SendAllPreflight>(SEND_ALL_API.preflight, { body: { filter, useOtherChannels: true } }).then(
      (p) => {
        if (!alive) return;
        setPre(p);
        if (p.runningJob) setJobId(p.runningJob.id);
      },
      (e) => alive && setError(toErr(e)),
    );
    return () => {
      alive = false;
    };
  }, [filter]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SendAllStartResponse>(SEND_ALL_API.start, { body: { filter, useOtherChannels: useOther } });
      setJobId(r.job.id);
    } catch (e) {
      setError(toErr(e));
    } finally {
      setBusy(false);
    }
  };

  const title = pre?.buttonLabel ?? "Send all";
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent title={title} wide>
        <div className="flex flex-col gap-3 text-sm" data-testid="send-all-dialog">
          <div className="flex items-center gap-2">
            <InfoTip place="send-all-preflight" label="About sending all">
              WhatsApp goes out automatically only through the official WhatsApp Cloud API — never WhatsApp Web. Messages that are no longer
              needed, duplicates and expired ones are skipped. Anything that can&apos;t be sent stays in the queue with its reason.
            </InfoTip>
            {pre ? <span className="text-muted-foreground" data-testid="send-all-total">{pre.total} message{pre.total === 1 ? "" : "s"} in this view</span> : null}
          </div>
          <RejectionBanner error={error} />
          {jobId ? (
            <JobProgress id={jobId} onDone={() => undefined} />
          ) : !pre ? (
            <p className="text-muted-foreground">{error ? null : "Checking the queue…"}</p>
          ) : (
            <Preflight pre={pre} useOther={useOther} busy={busy} onToggle={(v) => { setUseOther(v); void load(v); }} />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{jobId ? "Close" : "Cancel"}</Button>
            {!jobId && pre ? (
              <Button onClick={confirm} disabled={busy || (pre.willSend.tasks === 0 && pre.skipped.total === 0)} data-testid="send-all-confirm">
                {pre.willSend.tasks ? `${pre.buttonLabel} (${pre.willSend.tasks})` : "Clean up the queue"}
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Preflight({ pre, useOther, busy, onToggle }: { pre: SendAllPreflight; useOther: boolean; busy: boolean; onToggle: (v: boolean) => void }) {
  return (
    <div className="flex flex-col gap-3" data-testid="send-all-preflight">
      {!pre.whatsappApi.on ? (
        <div className="rounded-xl border border-warning/50 bg-warning/10 p-3" data-testid="send-all-no-api">
          <p className="font-semibold">WhatsApp can&apos;t be sent automatically: the WhatsApp API isn&apos;t set up.</p>
          {pre.setupHref ? (
            <Link className="font-semibold text-primary hover:underline" href={pre.setupHref} data-testid="send-all-setup-link">Settings → WhatsApp</Link>
          ) : (
            <p data-testid="send-all-ask-owner">Ask the owner to finish WhatsApp setup.</p>
          )}
        </div>
      ) : null}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={useOther} disabled={busy} onChange={(e) => onToggle(e.target.checked)} data-testid="send-all-use-other" />
        Use other channels when WhatsApp isn&apos;t possible
      </label>
      <ul className="divide-y rounded-xl border px-3">
        <Row label="WhatsApp — will send automatically" value={pre.willSend.whatsapp} testId="send-all-count-whatsapp" />
        <Row label="Email instead" value={pre.willSend.email} testId="send-all-count-email" />
        <Row label="Push instead" value={pre.willSend.push} testId="send-all-count-push" />
        <Row label="Skipped — not relevant any more" value={pre.skipped.notRelevant} testId="send-all-count-not-relevant" />
        <Row label="Skipped — duplicate" value={pre.skipped.duplicate} testId="send-all-count-duplicate" />
        <Row label="Skipped — expired" value={pre.skipped.expired} testId="send-all-count-expired" />
        <Row label="Can't send automatically" value={pre.cannot.total} testId="send-all-count-cannot" strong={pre.cannot.total > 0} />
        {pre.excludedAnnouncements ? <Row label="Announcements (need a manager or the owner)" value={pre.excludedAnnouncements} testId="send-all-count-announcements" /> : null}
      </ul>
      {pre.cannot.reasons.length ? (
        <ul className="text-xs text-muted-foreground" data-testid="send-all-cannot-reasons">
          {pre.cannot.reasons.map((r) => <li key={r.reason}>{r.reason}: {r.count}</li>)}
        </ul>
      ) : null}
      {pre.skipped.reasons.length ? (
        <ul className="text-xs text-muted-foreground" data-testid="send-all-skip-reasons">
          {pre.skipped.reasons.map((r) => <li key={r.reason}>{r.reason}: {r.count}</li>)}
        </ul>
      ) : null}
      {pre.samples.whatsapp || pre.samples.email || pre.samples.push ? (
        <div className="grid gap-2 md:grid-cols-3" data-testid="send-all-samples">
          {pre.samples.whatsapp ? (
            <div className="rounded-xl border p-2 text-xs" data-testid="send-all-sample-whatsapp">
              <p className="font-semibold">WhatsApp · {pre.samples.whatsapp.template}</p>
              <p className="text-muted-foreground">{pre.samples.whatsapp.to}</p>
              <p className="whitespace-pre-line">{pre.samples.whatsapp.text}</p>
            </div>
          ) : null}
          {pre.samples.email ? (
            <div className="rounded-xl border p-2 text-xs" data-testid="send-all-sample-email">
              <p className="font-semibold">Email · {pre.samples.email.subject}</p>
              <p className="text-muted-foreground">{pre.samples.email.to}</p>
              <p className="whitespace-pre-line">{pre.samples.email.text}</p>
            </div>
          ) : null}
          {pre.samples.push ? (
            <div className="rounded-xl border p-2 text-xs" data-testid="send-all-sample-push">
              <p className="font-semibold">Push · {pre.samples.push.title}</p>
              <p className="whitespace-pre-line">{pre.samples.push.body}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function JobProgress({ id, onDone }: { id: string; onDone: () => void }) {
  const state = useApi<SendAllJob>(SEND_ALL_API.job(id), { pollMs: 2_000 });
  const j = state.data;
  const done = j?.status === "DONE";
  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);
  if (!j) return <p className="text-muted-foreground">Starting…</p>;
  const finished = j.sent + j.failed + j.skipped;
  const pct = j.total ? Math.round((finished / j.total) * 100) : 100;
  return (
    <div className="flex flex-col gap-2" data-testid="send-all-progress" data-status={j.status}>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Send all progress">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="divide-y rounded-xl border px-3">
        <Row label="Sent" value={j.sent} testId="send-all-sent" />
        <Row label="Failed (stay in the queue)" value={j.failed} testId="send-all-failed" />
        <Row label="Remaining" value={j.remaining} testId="send-all-remaining" />
        {j.skipped ? <Row label="No longer needed at send time" value={j.skipped} /> : null}
      </ul>
      {j.pausedUntil ? <p className="text-xs" data-testid="send-all-paused">WhatsApp paused by a rate limit until {new Date(j.pausedUntil).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} — it resumes by itself.</p> : null}
      {done ? (
        <div data-testid="send-all-summary">
          <p className="font-semibold">Done: {j.sent} sent, {j.failed} failed{j.preflight.skipped ? `, ${j.preflight.skipped} skipped` : ""}{j.preflight.cannot ? `, ${j.preflight.cannot} left for sending by hand` : ""}.</p>
          {j.failures.length ? (
            <ul className="text-xs text-muted-foreground">
              {j.failures.map((f) => <li key={f.taskId}>{f.name}: {f.reason}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">Job {j.id}</p>
    </div>
  );
}
