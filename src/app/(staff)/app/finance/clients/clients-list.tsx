"use client";
// v3 §3.2: business clients with the standard FilterBar — has outstanding, overdue, active — and a summary strip.
import Link from "next/link";
import { useState } from "react";
import { Building2 } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { EmailInput, PhoneInput } from "@/components/contact-inputs";
import { Money } from "@/components/money";

function NewClient({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", gstin: "", stateCode: "24", address: "", contactName: "", contactEmail: "", contactPhone: "", paymentTermsDays: "15" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild>
        <Button><Building2 className="h-4 w-4" /> New client</Button>
      </DialogTrigger>
      <DialogContent title="New business client" description="The server validates the GSTIN; its first two digits become the state code.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api("/api/clients", {
                body: {
                  name: f.name, gstin: f.gstin, stateCode: f.gstin ? undefined : f.stateCode, address: f.address, contactName: f.contactName,
                  contactEmail: f.contactEmail, contactPhone: f.contactPhone, paymentTermsDays: Number(f.paymentTermsDays),
                },
              });
              setOpen(false);
              setF({ name: "", gstin: "", stateCode: "24", address: "", contactName: "", contactEmail: "", contactPhone: "", paymentTermsDays: "15" });
              onDone();
            } catch (err) {
              setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Company name *"><Input value={f.name} onChange={set("name")} required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="GSTIN" hint="15 characters: 2-digit state code, PAN, entity number, Z, check digit"><Input value={f.gstin} onChange={set("gstin")} className="uppercase" /></Field>
            <Field label="State code" hint={f.gstin ? "Taken from the GSTIN" : "Used when there is no GSTIN"}>
              <Input value={f.gstin ? f.gstin.slice(0, 2) : f.stateCode} onChange={set("stateCode")} disabled={!!f.gstin} maxLength={2} />
            </Field>
          </div>
          <Field label="Billing address *"><Textarea value={f.address} onChange={set("address")} required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact person *"><Input value={f.contactName} onChange={set("contactName")} required /></Field>
            <Field label="Payment terms (days)"><Input inputMode="numeric" value={f.paymentTermsDays} onChange={set("paymentTermsDays")} /></Field>
            <Field label="Contact email"><EmailInput name="contactEmail" value={f.contactEmail} onChange={set("contactEmail")} /></Field>
            <Field label="Contact phone"><PhoneInput kind="contact" name="contactPhone" value={f.contactPhone} onChange={set("contactPhone")} /></Field>
          </div>
          <RejectionBanner error={error} />
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save client"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Row = {
  id: string; name: string; gstin: string | null; state_code: string; address: string; contact_name: string; contact_email: string | null; contact_phone: string | null;
  payment_terms_days: number; outstanding: number; invoices: number; overdue: number; active: boolean;
};

function NewClientButton() {
  const reload = useListReload();
  return <NewClient onDone={reload} />;
}

export function ClientsList() {
  return (
    <FilteredList<Row>
      list="clients"
      searchPlaceholder="Name, GSTIN or contact"
      toolbar={<NewClientButton />}
      columns={[
        { key: "client", header: "Client", cell: (c) => <><p className="font-medium">{c.name}{c.active ? null : <Badge tone="neutral" className="ml-2">Archived</Badge>}</p><p className="max-w-xs truncate text-xs text-muted-foreground">{c.address}</p></> },
        { key: "gstin", header: "GSTIN", cell: (c) => <span className="font-mono text-xs">{c.gstin ?? "—"}</span> },
        { key: "state", header: "State", cell: (c) => <>{c.state_code}{c.state_code === "24" ? " (intra)" : " (inter)"}</> },
        { key: "contact", header: "Contact", cell: (c) => <span className="text-sm">{c.contact_name}<br /><span className="text-xs text-muted-foreground">{c.contact_email ?? c.contact_phone ?? ""}</span></span> },
        { key: "terms", header: "Terms", cell: (c) => <>{c.payment_terms_days} days</> },
        {
          key: "outstanding",
          header: "Outstanding",
          className: "text-right",
          cell: (c) => (
            <span className="flex flex-col items-end">
              <Money paise={c.outstanding} />
              {c.overdue > 0 ? <Badge tone="red">{c.overdue} overdue</Badge> : null}
            </span>
          ),
        },
        {
          key: "actions",
          header: "",
          cell: (c) => (
            <span className="flex gap-2">
              <Link className="text-sm text-primary underline" href={`/app/finance/invoices?clientId=${c.id}`}>Invoices</Link>
              <Link className="text-sm text-primary underline" href={`/app/finance/invoices/new?clientId=${c.id}`}>New invoice</Link>
            </span>
          ),
        },
      ]}
      empty={{ title: "No business clients match these filters", hint: "Add a corporate client to invoice court packages and events." }}
    />
  );
}
