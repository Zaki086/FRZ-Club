"use client";
import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";

export function SetPasswordForm({ token }: { token: string }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  if (done) return <p className="rounded-md border border-green-300 bg-green-50 p-3">Password set. <Link className="font-semibold underline" href="/login">Log in</Link></p>;
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      if (pw !== pw2) return setError({ message: "The two passwords do not match." });
      try { await api("/api/auth/set-password", { body: { token, password: pw } }); setDone(true); }
      catch (err) { setError({ message: err instanceof ApiError ? err.message : String(err) }); }
    }}>
      <Field label="New password" hint="At least 8 characters"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required /></Field>
      <Field label="Repeat password"><Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required /></Field>
      <RejectionBanner error={error} />
      <Button type="submit" size="lg">Save password</Button>
    </form>
  );
}
