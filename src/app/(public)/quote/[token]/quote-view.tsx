"use client";
import Link from "next/link";
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { fmtDateTime } from "@/lib/time";

type Q = { name: string; lines: Array<{ description: string; amount: number; explanation: string }>; total: number; validUntil: string; expired: boolean; status: string; club: { name: string; phone: string; email: string } };

export function QuoteView({ token }: { token: string }) {
  const state = useApi<Q>(`/api/quote/${token}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <DataState state={state}>
      {(q) => (
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">{q.club.name}</p>
            <h1 className="text-2xl font-bold">Your quote, {q.name}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {q.expired ? <Badge tone="red">Expired</Badge> : q.status === "INTERESTED" ? <Badge tone="green">You said you&apos;re interested</Badge> : <Badge tone="blue">Valid</Badge>}
              <span className="text-muted-foreground">{q.expired ? "Was valid until" : "Valid until"} {fmtDateTime(q.validUntil)}</span>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="divide-y rounded-md border">
              {q.lines.map((l, i) => (
                <div key={i} className="flex items-start justify-between gap-3 p-3 text-sm">
                  <div>
                    <p className="font-medium">{l.description}</p>
                    <p className="text-xs text-muted-foreground">{l.explanation}</p>
                  </div>
                  <Money paise={l.amount} className="font-semibold" />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-lg">
              <span className="font-semibold">Total (GST included)</span>
              <Money paise={q.total} className="text-2xl font-bold" />
            </div>
            <RejectionBanner error={error} />
            {q.status === "INTERESTED" ? (
              <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm">
                <CheckCircle2 className="h-5 w-5 text-success-text" /> Thank you! Your contact at the club has been told and will call you shortly to get you started.
              </div>
            ) : q.expired ? (
              <p className="text-sm">This quote has expired. Please <Link className="text-primary underline" href="/enquire">get in touch</Link> for a fresh one.</p>
            ) : (
              <Button
                size="lg"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api(`/api/quote/${token}/interested`, { body: {} });
                    await state.reload();
                  } catch (e) {
                    setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                I&apos;m interested
              </Button>
            )}
            <p className="text-xs text-muted-foreground">Questions? Call {q.club.phone} or write to {q.club.email}.</p>
          </CardContent>
        </Card>
      )}
    </DataState>
  );
}
