"use client";
// v5 §3.2: undo the one-click unsubscribe from the same signed link.
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";

export function Resubscribe({ token, club }: { token: string; club: string }) {
  const [busy, setBusy] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const run = async (resubscribe: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ unsubscribed: boolean }>("/api/messages/unsubscribe", { body: { token: decodeURIComponent(token), resubscribe } });
      setSubscribed(!r.unsubscribed);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-2">
      {subscribed ? (
        <>
          <p className="text-sm" role="status" data-testid="resubscribed">You&apos;re subscribed again to announcements from {club}.</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(false)}>Unsubscribe again</Button>
        </>
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => run(true)} data-testid="resubscribe">Subscribe again</Button>
      )}
      <RejectionBanner error={error} />
    </div>
  );
}
