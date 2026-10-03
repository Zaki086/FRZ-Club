"use client";
// Completion pass §6 — the same account page for every role: contact details, last login, change password
// (logs out other devices), log out everywhere.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, useApi } from "./api";
import { DataState, RejectionBanner } from "./states";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Field, Input } from "./ui/input";
import { fmtDateTime } from "@/lib/time";

type Profile = {
  name: string; phone: string; email: string | null; role: string; lastLoginAt: string | null; passwordChangedAt: string | null; activeSessions: number;
  member: { memberCode: string; emergencyContactName: string | null; emergencyContactPhone: string | null } | null;
};

const errOf = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

function Details({ p, onSaved }: { p: Profile; onSaved: () => void }) {
  const [email, setEmail] = useState(p.email ?? "");
  const [ecName, setEcName] = useState(p.member?.emergencyContactName ?? "");
  const [ecPhone, setEcPhone] = useState(p.member?.emergencyContactPhone ?? "");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <CardHeader><CardTitle>Your details</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="grid grid-cols-2 gap-1">
          <span className="text-muted-foreground">Name</span><span>{p.name}</span>
          <span className="text-muted-foreground">Mobile (login)</span><span>{p.phone}</span>
          {p.member ? (<><span className="text-muted-foreground">Member code</span><span className="font-mono">{p.member.memberCode}</span></>) : (<><span className="text-muted-foreground">Role</span><span>{p.role.replace("_", " ").toLowerCase()}</span></>)}
          <span className="text-muted-foreground">Last login</span><span data-testid="last-login">{p.lastLoginAt ? fmtDateTime(p.lastLoginAt) : "—"}</span>
        </div>
        <p className="text-xs text-muted-foreground">To change your name or mobile number, ask the {p.member ? "front desk" : "club owner"}.</p>
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {p.member ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Emergency contact"><Input value={ecName} onChange={(e) => setEcName(e.target.value)} /></Field>
            <Field label="Emergency contact mobile"><Input inputMode="tel" value={ecPhone} onChange={(e) => setEcPhone(e.target.value)} /></Field>
          </div>
        ) : null}
        <RejectionBanner error={error} />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={async () => {
              setError(null);
              setSaved(false);
              try {
                await api("/api/account", { method: "PUT", body: { email, ...(p.member ? { emergencyContactName: ecName, emergencyContactPhone: ecPhone } : {}) } });
                setSaved(true);
                onSaved();
              } catch (e) {
                setError(errOf(e));
              }
            }}
          >
            Save details
          </Button>
          {saved ? <span className="text-xs text-success-text">Saved</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Password({ changedAt }: { changedAt: string | null }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [done, setDone] = useState(false);
  return (
    <Card>
      <CardHeader><CardTitle>Password</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {changedAt ? <p className="text-xs text-muted-foreground">Last changed {fmtDateTime(changedAt)}.</p> : null}
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Repeat the new password"><Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} /></Field>
        <RejectionBanner error={error} />
        {done ? <p className="text-success-text" data-testid="password-changed">Password changed. Other devices have been logged out.</p> : null}
        <Button
          size="sm"
          className="self-start"
          onClick={async () => {
            setError(null);
            setDone(false);
            if (next !== repeat) return setError({ code: "VALIDATION_FAILED", message: "The new passwords don't match." });
            try {
              await api("/api/account/password", { body: { current, next } });
              setCurrent("");
              setNext("");
              setRepeat("");
              setDone(true);
            } catch (e) {
              setError(errOf(e));
            }
          }}
        >
          Change password
        </Button>
      </CardContent>
    </Card>
  );
}

export function AccountPanel() {
  const router = useRouter();
  const state = useApi<Profile>("/api/account");
  return (
    <DataState state={state}>
      {(p) => (
        <div className="flex flex-col gap-4">
          <Details p={p} onSaved={() => void state.reload()} />
          <Password changedAt={p.passwordChangedAt} />
          <Card>
            <CardHeader><CardTitle>Devices</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p>You are logged in on {p.activeSessions} device{p.activeSessions === 1 ? "" : "s"}.</p>
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={async () => {
                  await api("/api/account/logout-all", { body: {} });
                  router.push("/login");
                  router.refresh();
                }}
              >
                Log out on all devices
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </DataState>
  );
}
