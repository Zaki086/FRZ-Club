"use client";
// v4 §5.1: an existing member turns automatic WhatsApp updates on or off in the portal (stored with the time).
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WHATSAPP_OPT_IN_LABEL } from "@/components/whatsapp-opt-in";
import { InfoTip } from "@/components/info-tip";

type OptIn = { optedIn: boolean; optInAt: string | null; optOutAt: string | null; phoneLast4: string; automatic: boolean; juniors: number };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

export function WhatsAppConsentCard() {
  const state = useApi<OptIn>("/api/whatsapp/opt-in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <Card data-testid="whatsapp-consent">
      <CardHeader><CardTitle>WhatsApp updates</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <DataState state={state}>
          {(s) => (
            <>
              <div className="flex items-start gap-1">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={s.optedIn}
                  disabled={busy}
                  data-testid="whatsapp-opt-in-toggle"
                  onChange={async (e) => {
                    setBusy(true);
                    setError(null);
                    try {
                      state.setData(await api<OptIn>("/api/whatsapp/opt-in", { body: { optIn: e.target.checked } }));
                    } catch (err) {
                      setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <span>
                  {WHATSAPP_OPT_IN_LABEL} (number ending {s.phoneLast4})
                  {s.optedIn && s.optInAt ? <span className="block text-xs text-muted-foreground">Agreed {when(s.optInAt)}</span> : s.optOutAt ? <span className="block text-xs text-muted-foreground">Turned off {when(s.optOutAt)}</span> : null}
                </span>
              </label>
              <InfoTip place="whatsapp-opt-in" label="About WhatsApp updates" align="end">
                {s.juniors ? "This also covers messages about your Juniors. " : ""}
                Reply STOP on WhatsApp at any time to stop them.
                {!s.automatic ? " The club sends WhatsApp messages by hand for now." : ""}
              </InfoTip>
              </div>
              <RejectionBanner error={error} />
            </>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
