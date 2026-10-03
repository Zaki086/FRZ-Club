"use client";
// v3 §6.3 / v4 §4.2: the person's notification channels. In-app is always on; push is offered only when the club has
// set it up (HTTPS + keys) and asks this device's permission only on a click; the devices that receive push are
// listed (browser, added date) with Remove. Email and WhatsApp follow what the club really has.
import { useEffect, useState } from "react";
import { Smartphone, Trash2 } from "lucide-react";
import { api, ApiError, useApi } from "./api";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { RejectionBanner } from "./states";
import { useCapabilities } from "./capabilities";
import { currentPushEndpoint, enablePushOnThisDevice, pushSupport, type PushSupport } from "./push-opt-in";

type Device = { id: string; label: string; endpoint: string; addedAt: string; lastSuccessAt: string | null };
type Settings = {
  inApp: true;
  push: { on: boolean; available: boolean; devices: number; deviceList: Device[] };
  email: { on: boolean; available: boolean; address: string | null };
  whatsapp: { on: boolean; automatic: boolean; phone: string };
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

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
  // Nothing renders before the settings load (client-side), so reading the browser here can't mismatch the server.
  const [support] = useState<PushSupport>(() => pushSupport());
  const [here, setHere] = useState<string | null>(null);
  useEffect(() => {
    void currentPushEndpoint().then(setHere);
  }, []);
  const s = state.data;
  if (!s) return null;
  const fail = (e: unknown) => setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: e instanceof Error ? e.message : String(e) });
  const save = async (patch: Record<string, boolean>) => {
    setError(null);
    try {
      state.setData(await api<Settings>("/api/me/notifications", { method: "PUT", body: patch }));
    } catch (e) {
      fail(e);
    }
  };
  const enablePush = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!caps?.pushKey) throw new Error("Push notifications are not set up for this club.");
      state.setData(await enablePushOnThisDevice<Settings>(caps.pushKey));
      setHere(await currentPushEndpoint());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (d: Device) => {
    setBusy(true);
    setError(null);
    try {
      if (d.endpoint === here) {
        // This browser: also stop its subscription, so it doesn't come back on its own.
        const reg = await navigator.serviceWorker.getRegistration();
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
        setHere(null);
      }
      state.setData(await api<Settings>(`/api/push/subscriptions/${d.id}`, { method: "DELETE" }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const thisDeviceOn = !!here && s.push.deviceList.some((d) => d.endpoint === here);
  return (
    <Card data-testid="notification-settings">
      <CardHeader><CardTitle>How we reach you</CardTitle></CardHeader>
      <CardContent className="divide-y text-sm">
        <Toggle label="In the app" hint="Always on — everything appears under the bell." on disabled onChange={() => {}} />
        {s.push.available ? (
          <div className="flex flex-col gap-2 py-2">
            <Toggle label="Push notifications" hint={s.push.devices ? `On ${s.push.devices} device${s.push.devices > 1 ? "s" : ""}.` : "Not turned on on any device yet."} on={s.push.on} onChange={(v) => save({ push: v })} />
            {s.push.on && support === "supported" && !thisDeviceOn ? (
              <div><Button size="sm" variant="outline" disabled={busy} onClick={enablePush}>Turn on for this device</Button></div>
            ) : null}
            {support === "ios-needs-home-screen" ? (
              <p className="text-xs text-muted-foreground">
                On iPhone and iPad, alerts work only after you add this site to your Home Screen (Share → “Add to Home Screen”, iOS 16.4 or later) and open it from there.
              </p>
            ) : null}
            {s.push.deviceList.length ? (
              <ul className="flex flex-col gap-1" aria-label="Devices with push notifications" data-testid="push-devices">
                {s.push.deviceList.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{d.label}{d.endpoint === here ? " (this device)" : ""}</span>
                        <span className="text-xs text-muted-foreground">Added {day(d.addedAt)}{d.lastSuccessAt ? ` · last alert ${day(d.lastSuccessAt)}` : ""}</span>
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(d)} aria-label={`Remove ${d.label}`}>
                      <Trash2 className="h-4 w-4" aria-hidden /> Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
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
