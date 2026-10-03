"use client";
import Link from "next/link";
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ConsentFields } from "@/components/consent-fields";
import { useCapabilities } from "@/components/capabilities";

const INTERESTS = ["Gold membership", "Silver membership", "Junior membership", "Coaching", "Corporate package", "Court booking", "Other"];

export function EnquiryForm() {
  const [f, setF] = useState({ name: "", phone: "", email: "", interest: INTERESTS[0], message: "" });
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const caps = useCapabilities();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  if (ref) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <CheckCircle2 className="h-10 w-10 text-primary" />
          <h2 className="text-2xl font-bold">Thanks, {f.name.split(" ")[0]}!</h2>
          <p>Your reference is <span className="font-mono font-semibold">{ref}</span>. Someone from our team will get back to you within 24 hours.</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild><Link href="/trial">Book a free trial meanwhile</Link></Button>
            <Button asChild variant="outline"><Link href="/plans">See plans</Link></Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="pt-5">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await api<{ leadCode: string }>("/api/enquiry", { body: { name: f.name, phone: f.phone || undefined, email: f.email || undefined, interest: f.interest, message: f.message, consent, website: website || undefined } });
              setRef(r.leadCode);
            } catch (err) {
              setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Full name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Mobile"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" autoComplete="tel" /></Field>
            <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">Give us a phone number or an email so we can reply.</p>
          <Field label="I'm interested in">
            <Select value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })}>
              {INTERESTS.map((i) => <option key={i}>{i}</option>)}
            </Select>
          </Field>
          <Field label="Message"><Textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} rows={4} /></Field>
          <ConsentFields consent={consent} onConsent={setConsent} website={website} onWebsite={setWebsite} clubName={caps?.clubName} />
          <RejectionBanner error={error} />
          <Button type="submit" size="lg" disabled={busy}>{busy ? "Sending…" : "Send enquiry"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
