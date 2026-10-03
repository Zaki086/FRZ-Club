"use client";
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
              const next = params.get("next");
              router.push(next && next.startsWith("/") ? next : res.home);
              router.refresh();
            } catch (err) {
              setError(err instanceof ApiError ? { message: err.message } : { message: String(err) });
              setBusy(false);
            }
          }}
        >
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
        </form>
      </CardContent>
    </Card>
  );
}
