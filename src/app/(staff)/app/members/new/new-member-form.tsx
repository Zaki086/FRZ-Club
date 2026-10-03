"use client";
import Link from "next/link";
import { useState } from "react";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { PhotoInput } from "@/components/photo-input";
import { RejectionBanner } from "@/components/states";
import { MemberCard } from "@/components/member-card";
import { CredentialsPanel } from "@/components/credentials-panel";
import { PaymentPanel } from "@/components/payment-panel";
import { Money } from "@/components/money";
import { cn } from "@/components/ui/cn";
import { DrawerOpener, emptyTender, ProofFields, tenderProof, UpiQr, useTenderMethods, type TenderDraft } from "@/components/tender-fields";
import { METHOD_LABEL } from "@/components/capabilities";

/** True when the date of birth makes the person under 18 today (the server checks again). */
function underEighteen(dob: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
  const d = new Date(`${dob}T00:00:00`);
  const now = new Date();
  const eighteen = new Date(d.getFullYear() + 18, d.getMonth(), d.getDate());
  return eighteen > now;
}

type Plan = { id: string; code: string; name: string; description: string; price1m: number; price3m: number; price12m: number; shopDiscountPct: number; barDiscountPct: number; advanceBookingDays: number; courtFees: { sport: string; fee: number }[] };
type Result = { memberId: string; memberCode: string; membershipStatus: string | null; billId: string | null; billStatus: string | null; setPasswordToken: string | null };

export function NewMemberForm({ prefill }: { prefill: { name: string; phone: string; email: string; leadId: string } }) {
  const plans = useApi<Plan[]>("/api/plans");
  const [f, setF] = useState({ name: prefill.name, phone: prefill.phone, email: prefill.email, dob: "", emergencyContactName: "", emergencyContactPhone: "", guardianName: "", guardianPhone: "" });
  const [consent, setConsent] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [plan, setPlan] = useState<string>("SILVER");
  const [months, setMonths] = useState<1 | 3 | 12>(1);
  const methods = useTenderMethods() ?? ["CASH"];
  const [payNow, setPayNow] = useState(true);
  const [tender, setTender] = useState<TenderDraft>(emptyTender("CASH"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [key] = useState(newIdempotencyKey);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  if (result) {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>
              {f.name} is registered as {result.memberCode}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <MemberCard memberId={result.memberId} />
            {/* WK-5: the login is created when the membership is paid; the panel shows how the welcome went out. */}
            <CredentialsPanel memberId={result.memberId} initialToken={result.setPasswordToken} />
            {result.billId && result.billStatus !== "PAID" ? (
              <div>
                <p className="mb-2 font-semibold">Membership payment</p>
                <PaymentPanel billId={result.billId} />
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button asChild>
                <Link href={`/app/members/${result.memberId}`}>Open profile</Link>
              </Button>
              <Button variant="outline" onClick={() => window.location.reload()}>
                Sign up another
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const selected = plans.data?.find((p) => p.code === plan);
  const price = selected ? (months === 1 ? selected.price1m : months === 3 ? selected.price3m : selected.price12m) : 0;

  return (
    <form
      className="grid gap-4 lg:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const payment = plan && payNow ? tenderProof(tender) : undefined;
          const r = await api<Result>("/api/members", {
            body: {
              ...f,
              guardianName: underEighteen(f.dob) ? f.guardianName : undefined,
              guardianPhone: underEighteen(f.dob) ? f.guardianPhone : undefined,
              consent,
              photoUrl: photo ?? undefined,
              leadId: prefill.leadId || undefined,
              plan: plan ? { code: plan, months, payment } : undefined,
            },
            idempotencyKey: key,
          });
          setResult(r);
        } catch (err) {
          setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <PhotoInput value={photo} onChange={setPhoto} />
          <Field label="Full name *">
            <Input name="name" value={f.name} onChange={set("name")} required autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mobile *" hint="10-digit Indian mobile">
              <Input name="phone" inputMode="tel" value={f.phone} onChange={set("phone")} required />
            </Field>
            <Field label="Date of birth *">
              <Input name="dob" type="date" value={f.dob} onChange={set("dob")} required />
            </Field>
          </div>
          <Field label="Email" hint="Optional — used for reminders and invoices">
            <Input name="email" type="email" value={f.email} onChange={set("email")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Emergency contact">
              <Input name="emergencyContactName" value={f.emergencyContactName} onChange={set("emergencyContactName")} />
            </Field>
            <Field label="Emergency phone">
              <Input name="emergencyContactPhone" value={f.emergencyContactPhone} onChange={set("emergencyContactPhone")} />
            </Field>
          </div>
          {underEighteen(f.dob) ? (
            <div className="grid grid-cols-2 gap-3 rounded-md border border-junior/30 bg-junior/10 p-2">
              <p className="col-span-2 text-xs text-junior">Under 18: a parent or guardian is required. If they are a member, they will see this member in their portal.</p>
              <Field label="Guardian's name *"><Input name="guardianName" value={f.guardianName} onChange={set("guardianName")} required /></Field>
              <Field label="Guardian's mobile *"><Input name="guardianPhone" inputMode="tel" value={f.guardianPhone} onChange={set("guardianPhone")} required /></Field>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Plan & payment</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            {(plans.data ?? []).map((p) => (
              <button
                type="button"
                key={p.code}
                onClick={() => setPlan(p.code)}
                className={cn("rounded-lg border p-3 text-left text-sm", plan === p.code ? "border-primary bg-accent ring-2 ring-primary" : "hover:bg-muted")}
              >
                <p className="font-semibold">{p.name}</p>
                <p className="text-xs text-muted-foreground">Shop {p.shopDiscountPct}% · Bar {p.barDiscountPct}%</p>
                <p className="text-xs text-muted-foreground">Book {p.advanceBookingDays} days ahead</p>
              </button>
            ))}
            <button type="button" onClick={() => setPlan("")} className={cn("col-span-3 rounded-lg border p-2 text-sm", plan === "" ? "border-primary bg-accent" : "hover:bg-muted")}>
              Register without a plan (walk-in rates)
            </button>
          </div>
          {plan ? (
            <>
              <Field label="Duration">
                <Select name="months" value={months} onChange={(e) => setMonths(Number(e.target.value) as 1 | 3 | 12)}>
                  <option value={1}>1 month</option>
                  <option value={3}>3 months</option>
                  <option value={12}>12 months</option>
                </Select>
              </Field>
              <p className="text-sm">
                Plan price: <Money paise={price} className="font-semibold" /> <span className="text-muted-foreground">(GST inclusive; Junior requires age under 18)</span>
              </p>
              <Field label="Payment now">
                <Select
                  name="method"
                  value={payNow ? tender.method : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPayNow(!!v);
                    if (v) setTender({ ...tender, method: v as TenderDraft["method"] });
                  }}
                >
                  {methods.map((m) => (
                    <option key={m} value={m}>{METHOD_LABEL[m]}</option>
                  ))}
                  <option value="">Not now — membership stays pending</option>
                </Select>
              </Field>
              {payNow && tender.method !== "CASH" ? (
                <Field label={tender.method === "UPI" ? "UPI reference (UTR)" : "Card approval code and last 4"}>
                  <ProofFields value={tender} onChange={(patch) => setTender({ ...tender, ...patch })} />
                </Field>
              ) : null}
              {payNow && tender.method === "UPI" ? <UpiQr amountPaise={price || null} note={`Membership ${f.name}`.slice(0, 40)} /> : null}
            </>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} required data-testid="member-consent" />
            The member agrees that the club stores these details to run their membership (<a className="underline" href="/privacy" target="_blank" rel="noreferrer">privacy notice</a>).
          </label>
          {error?.code === "DRAWER_NOT_OPEN" ? <DrawerOpener onOpened={() => setError(null)} /> : <RejectionBanner error={error} />}
          <Button type="submit" size="lg" disabled={busy} data-testid="signup-submit">
            {busy ? "Signing up…" : "Sign up member"}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
