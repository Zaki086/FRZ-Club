"use client";
// v4 §4.2 Web Push opt-in. The browser's permission prompt never appears on page load: after login a dismissible card
// offers alerts and the prompt appears only when "Enable" is pressed (Notification.requestPermission → subscribe →
// POST /api/push/subscriptions). On iPhone and iPad, Web Push works only for a site added to the Home Screen
// (iOS 16.4 or later), so there the card explains that instead of offering a button that can't work.
import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { api, ApiError } from "./api";
import { useCapabilities } from "./capabilities";
import { RejectionBanner } from "./states";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

export type PushSupport = "supported" | "ios-needs-home-screen" | "unsupported";

/** What this browser can do with Web Push. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "ios-needs-home-screen";
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "supported";
}

function urlB64ToUint8Array(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
}

/** This browser's current push subscription endpoint, if any (marks "this device" in the device list). */
export async function currentPushEndpoint(): Promise<string | null> {
  if (pushSupport() !== "supported") return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** Ask for permission (only ever after a click), subscribe this browser and register it for the logged-in person. */
export async function enablePushOnThisDevice<T = unknown>(publicKey: string): Promise<T> {
  if (pushSupport() !== "supported") throw new Error("This browser can't receive push notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again." : "Notifications were not allowed.");
  }
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) }));
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  return api<T>("/api/push/subscriptions", { body: { endpoint: j.endpoint, keys: j.keys, userAgent: navigator.userAgent.slice(0, 300) } });
}

const DISMISS_KEY = "cc.push-card.dismissed";

/** The card itself. `audience` only changes the one-line explanation (members vs staff). */
export function PushOptInCard({ audience = "member" }: { audience?: "member" | "staff" }) {
  const caps = useCapabilities();
  const key = caps?.pushKey ?? null;
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    void (async () => {
      let dismissed = false;
      try {
        dismissed = window.localStorage.getItem(DISMISS_KEY) === "1";
      } catch {
        dismissed = false;
      }
      const s = pushSupport();
      if (dismissed || s === "unsupported") return;
      // Already decided on this device: blocked, or on and subscribed — nothing to offer.
      if (s === "supported" && (Notification.permission === "denied" || (Notification.permission === "granted" && (await currentPushEndpoint())))) return;
      if (alive) setSupport(s);
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  if (!key || !support) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // private mode: the card simply comes back next time
    }
    setSupport(null);
  };
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await enablePushOnThisDevice(key);
      setEnabled(true);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="push-opt-in">
      <CardContent className="flex items-start gap-3 p-4 text-sm">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="font-semibold">Get alerts for bookings, refunds and renewals</p>
          {enabled ? (
            <p>Alerts are on for this device. You can turn them off in your notification settings.</p>
          ) : support === "ios-needs-home-screen" ? (
            <p className="text-muted-foreground">
              On iPhone and iPad, alerts work only after you add this site to your Home Screen (tap Share, then “Add to Home Screen”; iOS 16.4 or later).
              Open it from the Home Screen and tap Enable here.
            </p>
          ) : (
            <p className="text-muted-foreground">
              {audience === "staff"
                ? "Leads assigned to you, refunds and leave waiting for a decision, and drawer variances — on this device, even when the app is closed."
                : "A message on this device when a booking changes, a refund is ready to collect or your membership is due — even when the app is closed."}
            </p>
          )}
          {support === "supported" && !enabled ? (
            <div>
              <Button size="sm" onClick={enable} disabled={busy}>{busy ? "Enabling…" : "Enable"}</Button>
            </div>
          ) : null}
          <RejectionBanner error={error} />
        </div>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-secondary" aria-label="Dismiss" onClick={dismiss}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </CardContent>
    </Card>
  );
}
