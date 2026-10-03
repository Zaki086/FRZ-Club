"use client";
import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";

export function ForgotForm() {
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5">
        {message ? (
          <p className="rounded-md border border-success/40 bg-success/10 p-3 text-sm" data-testid="forgot-result">{message}</p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ message: string }>("/api/auth/forgot", { body: { identifier } });
                setMessage(r.message);
              } catch (err) {
                setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Mobile number or email"><Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoComplete="username" /></Field>
            <RejectionBanner error={error} />
            <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Get a reset link"}</Button>
          </form>
        )}
        <Link href="/login" className="text-sm text-primary underline">Back to login</Link>
      </CardContent>
    </Card>
  );
}
