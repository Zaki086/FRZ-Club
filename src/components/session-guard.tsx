"use client";
// v3 §6.1: when any API call answers 401 the page stays where it is and this dialog asks for the password again;
// after logging in the page reloads its data and the person carries on. "Go to the login page" keeps returnTo.
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as D from "@radix-ui/react-dialog";
import { api, ApiError, SESSION_ENDED_EVENT, SESSION_RESTORED_EVENT } from "./api";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";
import { LoginIdentifierInput } from "./contact-inputs";
import { RejectionBanner } from "./states";

export function SessionGuard() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);

  useEffect(() => {
    const onEnded = () => setOpen(true);
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);

  const returnTo = typeof window === "undefined" ? pathname : window.location.pathname + window.location.search;
  return (
    <D.Root open={open}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[60] bg-ink/60 backdrop-blur-[2px]" />
        <D.Content
          data-testid="session-guard"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[60] w-[calc(100vw-1.5rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-5 shadow-lift sm:p-6"
        >
          <D.Title className="font-display text-2xl font-bold uppercase">Your session ended</D.Title>
          <D.Description className="mb-4 text-sm text-muted-foreground">Your session ended — log in again to continue.</D.Description>
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await api("/api/auth/login", { body: { identifier, password } });
                setPassword("");
                setOpen(false);
                window.dispatchEvent(new CustomEvent(SESSION_RESTORED_EVENT));
                router.refresh();
              } catch (err) {
                setError({ message: err instanceof ApiError ? err.message : String(err) });
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Phone or email">
              <LoginIdentifierInput name="identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoFocus />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <RejectionBanner error={error} />
            <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Log in"}</Button>
            <a className="text-center text-sm text-primary underline" href={`/login?returnTo=${encodeURIComponent(returnTo)}&ended=1`}>Go to the login page</a>
          </form>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
