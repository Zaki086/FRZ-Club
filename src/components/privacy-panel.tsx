"use client";
// DPDP (completion pass P1): a member's own data — download it, or ask for it to be erased.
import { useState } from "react";
import { api, ApiError, useApi } from "./api";
import { RejectionBanner } from "./states";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Textarea } from "./ui/input";
import { ConfirmButton } from "./confirm";
import { fmtDateTime } from "@/lib/time";

type Req = { id: string; kind: string; status: string; note: string | null; createdAt: string; handledAt: string | null };

export function PrivacyPanel() {
  const reqs = useApi<Req[]>("/api/portal/erasure");
  const [note, setNote] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const openErase = (reqs.data ?? []).find((r) => r.kind === "ERASE" && r.status === "OPEN");
  return (
    <Card>
      <CardHeader><CardTitle>Your data</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <a className="self-start text-primary underline" href="/privacy">Privacy notice</a>
        <Button asChild variant="outline" size="sm" className="self-start">
          <a href="/api/portal/my-data" download data-testid="download-my-data">Download my data</a>
        </Button>
        {openErase ? (
          <p className="rounded-md border border-warning/50 bg-warning/15 p-2" data-testid="erasure-pending">Your erasure request of {fmtDateTime(openErase.createdAt)} is with the club.</p>
        ) : (
          <ConfirmButton
            trigger="Ask to erase my data"
            title="Erase my personal data?"
            description="The club removes your name, contact details, date of birth and photo and closes your login once nothing is outstanding (no amount due, open tab, upcoming booking or current membership). This can't be undone."
            confirmLabel="Send request"
            onConfirm={async () => {
              setError(null);
              try {
                await api("/api/portal/erasure", { body: { note: note || undefined } });
                await reqs.reload();
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
              }
            }}
          >
            <Textarea placeholder="Anything the club should know (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </ConfirmButton>
        )}
        <RejectionBanner error={error} />
        {(reqs.data ?? []).filter((r) => r.kind === "ERASE" && r.status !== "OPEN").map((r) => (
          <p key={r.id} className="text-xs text-muted-foreground">Erasure request {r.status.toLowerCase()} {r.handledAt ? fmtDateTime(r.handledAt) : ""}{r.note ? ` — ${r.note}` : ""}</p>
        ))}
      </CardContent>
    </Card>
  );
}
