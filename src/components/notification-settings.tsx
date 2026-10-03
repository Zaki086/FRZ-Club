"use client";
// v3 §6.3: the person's notification channels. In-app is always on; push is offered only when the club has set it
// up (HTTPS + keys) and asks this device's permission; email and WhatsApp follow what the club really has.
import { useState } from "react";
import { api, ApiError, useApi } from "./api";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { RejectionBanner } from "./states";
import { useCapabilities } from "./capabilities";

type Settings = {
  inApp: true;
  push: { on: boolean; available: boolean; devices: number };
  email: { on: boolean; available: boolean; address: string | null };
  whatsapp: { on: boolean; automatic: boolean; phone: string };
};

function urlB64ToUint8Array(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function Toggle({ label, hint, on, disabled, onChange }: { label: string; hint: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-3 py-2">
      <span className="flex flex-col"><span className="font-semibold">{label}</span><span className="text-xs text-muted-foreground">{hint}</span></span>
      <input type="checkbox" className="mt-1 h-5 w-5 accent-primary" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}

export function NotificationSettings() {
  const state = useApi<Settings>("/api/me/notifications");
  const caps = useCapabilities();
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = state.data;
  if (!s) return null;
  const save = async (patch: Record<string, boolean>) => {
    setError(null);
    try {
      state.setData(await api<Settings>("/api/me/notifications", { method: "PUT", body: patch }));
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    }
  };
  const enablePush = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = caps?.pushKey;
      if (!key || !("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser can't receive push notifications.");
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site in the browser settings.");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) }));
      const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      state.setData(await api<Settings>("/api/push/subscribe", { body: { endpoint: j.endpoint, keys: j.keys, userAgent: navigator.userAgent.slice(0, 300) } }));
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="notification-settings">
      <CardHeader><CardTitle>How we reach you</CardTitle></CardHeader>
      <CardContent className="divide-y text-sm">
        <Toggle label="In the app" hint="Always on — everything appears under the bell." on disabled onChange={() => {}} />
        {s.push.available ? (
          <div className="py-2">
            <Toggle label="Push notifications" hint={s.push.devices ? `On ${s.push.devices} device${s.push.devices > 1 ? "s" : ""}.` : "Not turned on on any device yet."} on={s.push.on} onChange={(v) => save({ push: v })} />
            {s.push.on ? <Button size="sm" variant="outline" disabled={busy} onClick={enablePush}>Turn on for this device</Button> : null}
          </div>
        ) : null}
        {s.email.available ? (
          <Toggle label="Email" hint={s.email.address ? `To ${s.email.address}.` : "No email address on file — ask the front desk to add one."} on={s.email.on} disabled={!s.email.address} onChange={(v) => save({ email: v })} />
        ) : null}
        <Toggle label="WhatsApp" hint={`To ${s.whatsapp.phone}${s.whatsapp.automatic ? "." : ", sent by the club from its phone."}`} on={s.whatsapp.on} onChange={(v) => save({ whatsapp: v })} />
        <RejectionBanner error={error} />
      </CardContent>
    </Card>
  );
}
