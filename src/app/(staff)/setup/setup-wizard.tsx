"use client";
// First-run wizard (completion pass §4). Each card saves through the normal settings/courts APIs (validated and
// audited on the server); "Open the staff app" is enabled only when the server says every required step is done.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Money } from "@/components/money";
import { loadCapabilities } from "@/components/capabilities";
import { isValidGstin } from "@/lib/codes";
import { INDIAN_STATES } from "@/lib/states";

type Step = { key: string; label: string; done: boolean; required: boolean; detail: string };
type Status = { steps: Step[]; ready: boolean };
type SettingRow = { key: string; value: unknown; verified: boolean };
type Club = { name: string; legal_name: string; address: string; state: string; state_code: string; gstin: string; phone: string; email: string; logo_url?: string };
type Court = { id: string; name: string; sport: string; active: boolean };
type Plan = { id: string; code: string; name: string; price1m: number; price3m: number; price12m: number };

function useSaver(after: () => void) {
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function Identity({ club, onSaved }: { club: Club; onSaved: () => void }) {
  const [f, setF] = useState<Club>(club);
  const { error, busy, run } = useSaver(onSaved);
  const gstinOk = !f.gstin || isValidGstin(f.gstin.toUpperCase());
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Club name *"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Legal name (on invoices)"><Input value={f.legal_name} onChange={(e) => setF({ ...f, legal_name: e.target.value })} /></Field>
        <Field label="Address *"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="State *">
          <Select
            value={f.state_code}
            onChange={(e) => setF({ ...f, state_code: e.target.value, state: INDIAN_STATES.find((s) => s.code === e.target.value)?.name ?? "" })}
          >
            <option value="">Choose…</option>
            {INDIAN_STATES.map((s) => (
              <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
            ))}
          </Select>
        </Field>
        <Field label="Phone"><Input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="GSTIN" hint={gstinOk ? "Leave empty if the club is not GST-registered — then no GST is charged" : "This GSTIN is not valid (format or check digit)"}>
          <Input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.trim().toUpperCase() })} />
        </Field>
      </div>
      <RejectionBanner error={error} />
      <Button className="self-start" disabled={busy || !gstinOk} onClick={() => run(() => api("/api/settings/club", { method: "PUT", body: { value: f } }))}>
        Save club details
      </Button>
    </div>
  );
}

function Gst({ hasGstin, verified, rates, onSaved }: { hasGstin: boolean; verified: boolean; rates: Record<string, number>; onSaved: () => void }) {
  const { error, busy, run } = useSaver(onSaved);
  if (!hasGstin) return <p className="text-sm text-muted-foreground">No GSTIN entered: the club is treated as not GST-registered and no GST is charged.</p>;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
        {Object.entries(rates).map(([k, v]) => (
          <span key={k} className="rounded border px-2 py-1">{k.replace(/_/g, " ").toLowerCase()}: <strong>{v}%</strong></span>
        ))}
      </div>
      <RejectionBanner error={error} />
      {verified ? (
        <p className="text-green-700">Rates confirmed.</p>
      ) : (
        <Button className="self-start" disabled={busy} onClick={() => run(() => api("/api/settings/tax_rates", { body: {} }))}>
          These GST rates are right — confirm
        </Button>
      )}
    </div>
  );
}

function Payments({ value, onSaved }: { value: { card_enabled: boolean; upi_vpa: string; upi_confirmed: boolean }; onSaved: () => void }) {
  const [card, setCard] = useState(value.card_enabled);
  const [vpa, setVpa] = useState(value.upi_vpa);
  const [confirmed, setConfirmed] = useState(value.upi_confirmed);
  const { error, busy, run } = useSaver(() => {
    void loadCapabilities(true);
    onSaved();
  });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">Cash is always accepted. Only switch on what the club really has.</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={card} onChange={(e) => setCard(e.target.checked)} /> We have a working card machine</label>
      <Field label="Club UPI ID (optional)" hint="e.g. clubname@okhdfcbank">
        <Input value={vpa} onChange={(e) => { setVpa(e.target.value.trim()); setConfirmed(false); }} />
      </Field>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={confirmed} disabled={!vpa} onChange={(e) => setConfirmed(e.target.checked)} />
        I sent a test payment to this UPI ID and it reached the club&apos;s account.
      </label>
      <p className="text-xs text-muted-foreground">Online payment turns on by itself once live Razorpay keys are added to the server.</p>
      <RejectionBanner error={error} />
      <Button className="self-start" disabled={busy} onClick={() => run(() => api("/api/settings/payment_methods", { method: "PUT", body: { value: { card_enabled: card, upi_vpa: vpa, upi_confirmed: confirmed && !!vpa } } }))}>
        Save payments
      </Button>
    </div>
  );
}

function Courts({ onSaved }: { onSaved: () => void }) {
  const courts = useApi<Court[]>("/api/courts");
  const [name, setName] = useState("");
  const [sport, setSport] = useState("TENNIS");
  const { error, busy, run } = useSaver(() => {
    setName("");
    void courts.reload();
    onSaved();
  });
  return (
    <div className="flex flex-col gap-2 text-sm">
      <DataState state={courts}>
        {(list) => (list.length ? <p>{list.map((c) => `${c.name} (${c.sport.toLowerCase()})`).join(" · ")}</p> : <p className="text-muted-foreground">No courts yet.</p>)}
      </DataState>
      <div className="flex flex-wrap gap-2">
        <Input className="w-40" placeholder="Court name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Court name" />
        <Select className="w-36" value={sport} onChange={(e) => setSport(e.target.value)} aria-label="Sport">
          <option value="TENNIS">Tennis</option>
          <option value="CRICKET">Cricket nets</option>
          <option value="PADEL">Padel</option>
          <option value="BADMINTON">Badminton</option>
        </Select>
        <Button disabled={busy || !name.trim()} onClick={() => run(() => api("/api/courts", { body: { name: name.trim(), sport } }))}>Add court</Button>
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

function Plans() {
  const plans = useApi<Plan[]>("/api/plans");
  return (
    <DataState state={plans}>
      {(list) => (
        <div className="flex flex-col gap-1 text-sm">
          {list.map((p) => (
            <p key={p.id}>
              <strong>{p.name}</strong>: <Money paise={p.price1m} /> / month · <Money paise={p.price3m} /> / 3 months · <Money paise={p.price12m} /> / year
            </p>
          ))}
          <p className="text-xs text-muted-foreground">Change prices, fees and discounts any time in Settings → Plans & fees.</p>
        </div>
      )}
    </DataState>
  );
}

export function SetupWizard() {
  const router = useRouter();
  const status = useApi<Status>("/api/setup");
  const settings = useApi<SettingRow[]>("/api/settings");
  const [finishError, setFinishError] = useState<{ code?: string; message: string } | null>(null);
  const reload = () => {
    void status.reload();
    void settings.reload();
  };
  const get = <T,>(k: string) => settings.data?.find((r) => r.key === k) as (SettingRow & { value: T }) | undefined;
  const club = get<Club>("club")?.value;
  const tax = get<Record<string, number>>("tax_rates");
  const pm = get<{ card_enabled: boolean; upi_vpa: string; upi_confirmed: boolean }>("payment_methods")?.value;
  const done = (k: string) => status.data?.steps.find((s) => s.key === k);
  const Head = ({ k, title }: { k: string; title: string }) => {
    const st = done(k);
    return (
      <CardTitle className="flex items-center gap-2">
        {st?.done ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <Circle className="h-5 w-5 text-muted-foreground" />}
        {title}
        {st ? <span className="text-xs font-normal text-muted-foreground">{st.detail}</span> : null}
      </CardTitle>
    );
  };
  return (
    <DataState state={settings}>
      {() => (
        <div className="flex flex-col gap-4" data-testid="setup-wizard">
          <Card>
            <CardHeader><Head k="identity" title="1. Club details" /></CardHeader>
            <CardContent>{club ? <Identity club={club} onSaved={reload} /> : null}</CardContent>
          </Card>
          <Card>
            <CardHeader><Head k="gst" title="2. GST" /></CardHeader>
            <CardContent>
              <Gst hasGstin={!!club?.gstin} verified={!!tax?.verified} rates={tax?.value ?? {}} onSaved={reload} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><Head k="payments" title="3. How the club takes payments" /></CardHeader>
            <CardContent>{pm ? <Payments value={pm} onSaved={reload} /> : null}</CardContent>
          </Card>
          <Card>
            <CardHeader><Head k="courts" title="4. Courts" /></CardHeader>
            <CardContent><Courts onSaved={reload} /></CardContent>
          </Card>
          <Card>
            <CardHeader><Head k="plans" title="5. Membership plans" /></CardHeader>
            <CardContent><Plans /></CardContent>
          </Card>
          <RejectionBanner error={finishError} />
          <Button
            size="lg"
            disabled={!status.data?.ready}
            data-testid="setup-finish"
            onClick={async () => {
              setFinishError(null);
              try {
                await api("/api/setup/complete", { body: {} });
                router.push("/app");
                router.refresh();
              } catch (e) {
                setFinishError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                reload();
              }
            }}
          >
            Open the staff app
          </Button>
        </div>
      )}
    </DataState>
  );
}
