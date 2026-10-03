"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { RejectionBanner } from "@/components/states";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  return (
    <Card>
      <CardContent className="pt-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const res = await api<{ home: string }>("/api/auth/login", { body: { identifier, password } });
              // Deep links win; a bare "/app" or "/portal" goes to the role's own home page (§6).
              const next = params.get("returnTo") ?? params.get("next");
              const safe = next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\");
              router.push(safe && next !== "/app" && next !== "/portal" ? next : res.home);
              router.refresh();
            } catch (err) {
              setError(err instanceof ApiError ? { code: err.code === "RATE_LIMITED" ? err.code : undefined, message: err.message } : { message: String(err) });
              setBusy(false);
            }
          }}
        >
          {params.get("ended") ? <p role="status" className="rounded-lg bg-warning/15 px-3 py-2 text-sm font-semibold text-warning-text">Your session ended — log in again to continue.</p> : null}
          <Field label="Phone or email">
            <Input
              name="identifier"
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="98765 43210"
              required
              autoFocus
            />
          </Field>
          <Field label="Password">
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <RejectionBanner error={error} />
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Signing in…" : "Log in"}
          </Button>
          <Link href="/forgot-password" className="text-center text-sm text-primary underline">Forgot your password?</Link>
        </form>
      </CardContent>
    </Card>
  );
}
