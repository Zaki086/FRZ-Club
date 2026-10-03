"use client";
import Link from "next/link";
import { useState } from "react";
import { Building2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Money } from "@/components/money";

type Client = { id: string; name: string; gstin: string | null; stateCode: string; address: string; contactName: string; contactEmail: string | null; contactPhone: string | null; paymentTermsDays: number; outstanding: number };

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
            <Field label="GSTIN" hint="15 characters, e.g. 27AAPFU0939F1ZV"><Input value={f.gstin} onChange={set("gstin")} className="uppercase" /></Field>
            <Field label="State code" hint={f.gstin ? "Taken from the GSTIN" : "Used when there is no GSTIN"}>
              <Input value={f.gstin ? f.gstin.slice(0, 2) : f.stateCode} onChange={set("stateCode")} disabled={!!f.gstin} maxLength={2} />
            </Field>
          </div>
          <Field label="Billing address *"><Textarea value={f.address} onChange={set("address")} required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact person *"><Input value={f.contactName} onChange={set("contactName")} required /></Field>
            <Field label="Payment terms (days)"><Input inputMode="numeric" value={f.paymentTermsDays} onChange={set("paymentTermsDays")} /></Field>
            <Field label="Contact email"><Input type="email" value={f.contactEmail} onChange={set("contactEmail")} /></Field>
            <Field label="Contact phone"><Input value={f.contactPhone} onChange={set("contactPhone")} /></Field>
          </div>
          <RejectionBanner error={error} />
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save client"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ClientsList() {
  const state = useApi<Client[]>("/api/clients");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end"><NewClient onDone={() => void state.reload()} /></div>
      <Card>
        <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No business clients yet", hint: "Add a corporate client to invoice court packages and events." }}>
          {(rows) => (
            <Table>
              <THead><TR><TH>Client</TH><TH>GSTIN</TH><TH>State</TH><TH>Contact</TH><TH>Terms</TH><TH className="text-right">Outstanding</TH><TH /></TR></THead>
              <TBody>
                {rows.map((c) => (
                  <TR key={c.id}>
                    <TD><p className="font-medium">{c.name}</p><p className="max-w-xs truncate text-xs text-muted-foreground">{c.address}</p></TD>
                    <TD className="font-mono text-xs">{c.gstin ?? "—"}</TD>
                    <TD>{c.stateCode}{c.stateCode === "24" ? " (intra)" : " (inter)"}</TD>
                    <TD className="text-sm">{c.contactName}<br /><span className="text-xs text-muted-foreground">{c.contactEmail ?? c.contactPhone ?? ""}</span></TD>
                    <TD>{c.paymentTermsDays} days</TD>
                    <TD className="text-right"><Money paise={c.outstanding} /></TD>
                    <TD className="flex gap-2">
                      <Link className="text-sm text-primary underline" href={`/app/finance/invoices?clientId=${c.id}`}>Invoices</Link>
                      <Link className="text-sm text-primary underline" href={`/app/finance/invoices/new?clientId=${c.id}`}>New invoice</Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
    </div>
  );
}
