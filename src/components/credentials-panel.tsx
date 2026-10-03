"use client";
// v3 §6.4 WK-5/WK-6: the member's login — username (their mobile), whether they have set a password, the one-time
// link's state, how the welcome went out on each channel, and the desk's actions: show the link as a QR, send it on
// WhatsApp by hand, print the 80 mm welcome slip, or issue a new link (the old one stops working).
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError, useApi } from "./api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { RejectionBanner } from "./states";
import { fmtDateTime } from "@/lib/time";

type Status = {
  username: string; memberCode: string; canLogIn: boolean; lastLoginAt: string | null; credentialsIssuedAt: string | null;
  linkActiveUntil: string | null; noOwnLogin: boolean;
  deliveries: Array<{ id: string; channel: string; status: string; error: string | null; at: string }>;
};

const CHANNEL: Record<string, string> = { IN_APP: "In-app", PUSH: "Push", EMAIL: "Email", WHATSAPP_API: "WhatsApp (automatic)", WHATSAPP_MANUAL: "WhatsApp (by hand)" };
const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" | "blue" }> = {
  SENT: { label: "Sent", tone: "green" }, DELIVERED: { label: "Delivered", tone: "green" }, QUEUED: { label: "To send", tone: "amber" },
  LINK_OPENED: { label: "WhatsApp opened", tone: "blue" }, FAILED: { label: "Failed", tone: "red" }, SKIPPED: { label: "Not available", tone: "neutral" },
};

export function linkFor(token: string) {
  return `${typeof window === "undefined" ? "" : window.location.origin}/set-password/${token}`;
}

function Qr({ text }: { text: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: 220 }).then((u) => live && setSrc(u)).catch(() => live && setSrc(null));
    return () => { live = false; };
  }, [text]);
  // eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not a remote image
  return src ? <img src={src} alt="QR code of the set-password link" width={220} height={220} className="rounded-lg border bg-white p-1" data-testid="credentials-qr" /> : null;
}

export function CredentialsPanel({ memberId, initialToken }: { memberId: string; initialToken?: string | null }) {
  const state = useApi<Status>(`/api/members/${memberId}/credentials`);
  const [token, setToken] = useState<string | null>(initialToken ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const s = state.data;
  if (!s) return null;
  const manual = s.deliveries.find((d) => d.channel === "WHATSAPP_MANUAL" && ["QUEUED", "LINK_OPENED"].includes(d.status));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await state.reload();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="credentials-panel">
      <CardHeader><CardTitle>Login</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {s.noOwnLogin ? (
          <p className="text-muted-foreground">Under 13 and managed by their guardian: no login of their own. The guardian sees them under Family in the portal.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1">
              <span className="text-muted-foreground">Username</span><span className="font-mono font-semibold">{s.username}</span>
              <span className="text-muted-foreground">Member code</span><span className="font-mono">{s.memberCode}</span>
              <span className="text-muted-foreground">Password</span>
              <span>{s.canLogIn ? <Badge tone="green">Set{s.lastLoginAt ? ` · last login ${fmtDateTime(s.lastLoginAt)}` : ""}</Badge> : s.credentialsIssuedAt ? <Badge tone="amber">Not set yet</Badge> : <Badge tone="neutral">Login created when the first membership is paid</Badge>}</span>
              {s.linkActiveUntil ? <><span className="text-muted-foreground">Link works until</span><span>{fmtDateTime(s.linkActiveUntil)}</span></> : null}
            </div>
            {token ? (
              <div className="flex flex-wrap items-start gap-3">
                <Qr text={linkFor(token)} />
                <p className="max-w-xs text-xs text-muted-foreground">The member scans this to set their own password now. The link works once.</p>
              </div>
            ) : null}
            {s.deliveries.length ? (
              <div className="flex flex-wrap gap-1" data-testid="credentials-deliveries">
                {s.deliveries.map((d) => (
                  <Badge key={d.id} tone={STATUS[d.status]?.tone ?? "neutral"} title={d.error ?? undefined}>{CHANNEL[d.channel] ?? d.channel}: {STATUS[d.status]?.label ?? d.status}</Badge>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {manual ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
                  const r = await api<{ url: string }>(`/api/messages/manual/${manual.id}/open`, { body: {} });
                  window.open(r.url, "_blank", "noopener");
                })}>Send on WhatsApp</Button>
              ) : null}
              {manual && manual.status === "LINK_OPENED" ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await api(`/api/messages/manual/${manual.id}/sent`, { body: {} }); })}>Mark WhatsApp sent</Button>
              ) : null}
              {token ? <Button size="sm" variant="outline" asChild><a href={`/print/welcome/${memberId}?t=${encodeURIComponent(token)}`} target="_blank" rel="noopener">Print welcome slip</a></Button> : null}
              {s.credentialsIssuedAt && !s.canLogIn ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { setToken((await api<{ token: string }>(`/api/members/${memberId}/credentials`, { body: {} })).token); })}>Issue a new link</Button>
              ) : null}
            </div>
          </>
        )}
        <RejectionBanner error={error} />
      </CardContent>
    </Card>
  );
}
