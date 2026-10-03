"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/money";
import { DrawerOpener, emptyTender, MethodSelect, ProofFields, tenderProof, useTenderMethods, type TenderDraft } from "@/components/tender-fields";
import { fmtDateTime } from "@/lib/time";

type Pending = { id: string; amount: number; billId: string; sourceType: string; customer: string; note: string | null; since: string };

function PayOut({ r, onDone }: { r: Pending; onDone: () => void }) {
  const methods = useTenderMethods() ?? ["CASH"];
  const [t, setT] = useState<TenderDraft>(emptyTender("CASH"));
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="pending-refund">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{r.customer} · <Money paise={r.amount} className="font-semibold" /></p>
        <p className="text-xs text-muted-foreground">{r.sourceType.replace(/_/g, " ").toLowerCase()} · since {fmtDateTime(r.since)}</p>
      </div>
      {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <MethodSelect methods={methods} value={t.method} onChange={(m) => setT({ ...t, method: m })} />
        <ProofFields kind="refund" className="sm:col-span-2" value={t} onChange={(p) => setT({ ...t, ...p })} />
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const proof = tenderProof(t, "refund");
              await api(`/api/refunds/${r.id}/complete`, { body: { method: proof.method, reference: "reference" in proof ? proof.reference : undefined, approvalCode: "approvalCode" in proof ? proof.approvalCode : undefined } });
              onDone();
            } catch (e) {
              setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          Paid out
        </Button>
      </div>
      {error?.code === "DRAWER_NOT_OPEN" ? <DrawerOpener onOpened={() => setError(null)} /> : <RejectionBanner error={error} />}
    </div>
  );
}

export function PendingRefunds() {
  const state = useApi<Pending[]>("/api/refunds/pending");
  return (
    <DataState state={state}>
      {(rows) =>
        rows.length === 0 ? (
          <Empty title="Nothing to pay out" hint="Refunds that need the desk appear here." />
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((r) => (
              <PayOut key={r.id} r={r} onDone={() => void state.reload()} />
            ))}
          </div>
        )
      }
    </DataState>
  );
}
