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
import { PaymentPanel } from "@/components/payment-panel";
import { Money } from "@/components/money";
import { cn } from "@/components/ui/cn";

type Plan = { id: string; code: string; name: string; description: string; price1m: number; price3m: number; price12m: number; shopDiscountPct: number; barDiscountPct: number; advanceBookingDays: number; courtFees: { sport: string; fee: number }[] };
type Result = { memberId: string; memberCode: string; membershipStatus: string | null; billId: string | null; billStatus: string | null; setPasswordToken: string | null };

export function NewMemberForm({ prefill }: { prefill: { name: string; phone: string; email: string; leadId: string } }) {
  const plans = useApi<Plan[]>("/api/plans");
  const [f, setF] = useState({ name: prefill.name, phone: prefill.phone, email: prefill.email, dob: "", emergencyContactName: "", emergencyContactPhone: "", password: "" });
  const [photo, setPhoto] = useState<string | null>(null);
  const [plan, setPlan] = useState<string>("SILVER");
  const [months, setMonths] = useState<1 | 3 | 12>(1);
  const [method, setMethod] = useState<"" | "CASH" | "CARD" | "UPI">("UPI");
  const [reference, setReference] = useState("");
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
            {result.setPasswordToken ? (
              <div className="rounded-md border bg-muted/50 p-3 text-sm">
                Portal password link (one-time, 7 days):{" "}
                <code className="break-all">{`${typeof window !== "undefined" ? window.location.origin : ""}/set-password/${result.setPasswordToken}`}</code>
              </div>
            ) : null}
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
          const r = await api<Result>("/api/members", {
            body: {
              ...f,
              photoUrl: photo ?? undefined,
              leadId: prefill.leadId || undefined,
              plan: plan ? { code: plan, months, payment: method ? { method, reference: reference || undefined } : undefined } : undefined,
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
          <Field label="Portal password" hint="Optional. Leave empty to generate a one-time set-password link.">
            <Input name="password" type="password" value={f.password} onChange={set("password")} autoComplete="new-password" />
          </Field>
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
                <Select name="method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                  <option value="UPI">UPI</option>
                  <option value="CARD">Card</option>
                  <option value="CASH">Cash</option>
                  <option value="">Not now — membership stays pending</option>
                </Select>
              </Field>
              {method && method !== "CASH" ? (
                <Field label={method === "UPI" ? "UPI reference (UTR)" : "Card last 4"}>
                  <Input name="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
                </Field>
              ) : null}
            </>
          ) : null}
          <RejectionBanner error={error} />
          <Button type="submit" size="lg" disabled={busy} data-testid="signup-submit">
            {busy ? "Signing up…" : "Sign up member"}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
