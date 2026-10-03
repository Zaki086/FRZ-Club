"use client";
// v3 §3.2: expense bills with the standard FilterBar — status (incl. derived overdue), category, vendor, bill attached —
// and a summary strip. The old `?status=OVERDUE` / `?status=UNPAID` links are the status facet. Pay, cancel and attach
// stay on the row.
import { useState } from "react";
import { Plus } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { StatusBadge } from "@/components/badges";
import { Money } from "@/components/money";
import { ConfirmButton } from "@/components/confirm";
import { parseRupees } from "@/lib/money";
import { RelTime } from "@/components/rel-time";
import { label } from "../_components/fmt";
import { uploadFile } from "@/components/upload";

type Expense = { id: string; vendor: string; category: string; description: string; amount: number; inputGst: number; billDate: string; dueDate: string; status: string; overdue: boolean; method: string | null; paidAt: string | null; attachmentUrl: string | null };

/** Completion pass §7 (accountant): attach the scanned bill (photo or PDF, ≤ 2 MB). */
function AttachBill({ e, onDone }: { e: Expense; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <label className="inline-flex cursor-pointer flex-col text-xs text-primary">
      <span className="underline">{busy ? "Uploading…" : e.attachmentUrl ? "Replace bill" : "Attach bill"}</span>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        className="hidden"
        onChange={async (ev) => {
          const file = ev.target.files?.[0];
          ev.target.value = "";
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            const url = await uploadFile("expense", file);
            await api(`/api/expenses/${e.id}/attachment`, { method: "PUT", body: { url } });
            onDone();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      {error ? <span className="text-red-700">{error}</span> : null}
    </label>
  );
}
const CATEGORIES = ["STOCK_PURCHASE", "UTILITIES", "RENT", "MAINTENANCE", "MARKETING", "OTHER"];

function NewExpense({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ vendor: "", category: "UTILITIES", description: "", amount: "", inputGst: "", billDate: "", dueDate: "" });
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> New expense</Button></DialogTrigger>
      <DialogContent title="New expense bill">
        <form className="flex flex-col gap-3" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const amount = parseRupees(f.amount);
          const inputGst = f.inputGst ? parseRupees(f.inputGst) : 0;
          if (!amount) return setError({ message: "Enter the bill amount in ₹." });
          if (inputGst === null) return setError({ message: "Input GST must be an amount in ₹." });
          setBusy(true);
          try {
            await api("/api/expenses", { body: { vendor: f.vendor, category: f.category, description: f.description, amount, inputGst, billDate: f.billDate || undefined, dueDate: f.dueDate || undefined } });
            setOpen(false);
            setF({ vendor: "", category: "UTILITIES", description: "", amount: "", inputGst: "", billDate: "", dueDate: "" });
            onDone();
          } catch (err) {
            setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
          } finally {
            setBusy(false);
          }
        }}>
          <Field label="Vendor *"><Input value={f.vendor} onChange={set("vendor")} required /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category"><Select value={f.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
            <Field label="Amount ₹ *"><Input inputMode="decimal" value={f.amount} onChange={set("amount")} required /></Field>
            <Field label="Input GST ₹"><Input inputMode="decimal" value={f.inputGst} onChange={set("inputGst")} /></Field>
            <Field label="Description"><Input value={f.description} onChange={set("description")} /></Field>
            <Field label="Bill date" hint="Default: today"><Input type="date" value={f.billDate} onChange={set("billDate")} /></Field>
            <Field label="Due date" hint="Default: bill date + 15 days"><Input type="date" value={f.dueDate} onChange={set("dueDate")} /></Field>
          </div>
          <RejectionBanner error={error} />
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save expense"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayExpense({ e, onDone }: { e: Expense; onDone: () => void }) {
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  return (
    <ConfirmButton trigger="Pay" variant="default" title={`Pay ${e.vendor}`} description="Records the payment and writes an EXPENSE entry to the ledger." confirmLabel="Mark paid"
      onConfirm={async () => { await api(`/api/expenses/${e.id}/pay`, { body: { method, reference: reference || undefined } }); onDone(); }}>
      <p className="text-sm">Amount: <Money paise={e.amount} className="font-semibold" /></p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Method"><Select value={method} onChange={(x) => setMethod(x.target.value)}><option value="BANK_TRANSFER">Bank transfer</option><option value="UPI">UPI</option><option value="CARD">Card</option><option value="CASH">Cash</option></Select></Field>
        <Field label="Reference"><Input value={reference} onChange={(x) => setReference(x.target.value)} /></Field>
      </div>
    </ConfirmButton>
  );
}

function NewExpenseButton() {
  const reload = useListReload();
  return <NewExpense onDone={reload} />;
}

function RowActions({ e }: { e: Expense }) {
  const reload = useListReload();
  if (e.status === "UNPAID") {
    return (
      <div className="flex gap-1">
        <PayExpense e={e} onDone={reload} />
        <ConfirmButton trigger="Cancel" title="Cancel expense bill" description="Unpaid bills are cancelled, never deleted." requireReason confirmLabel="Cancel bill"
          onConfirm={async (reason) => { await api(`/api/expenses/${e.id}/cancel`, { body: { reason } }); reload(); }} />
      </div>
    );
  }
  return e.paidAt ? <span className="text-xs text-muted-foreground">{e.method ? label(e.method) : null} · <RelTime when={e.paidAt} /></span> : null;
}

function BillCell({ e, canManage }: { e: Expense; canManage: boolean }) {
  const reload = useListReload();
  return (
    <>
      <p className="font-medium">{e.vendor}</p><p className="text-xs text-muted-foreground">{e.description}</p>
      <span className="flex gap-2">
        {e.attachmentUrl ? <a className="text-xs text-primary underline" href={e.attachmentUrl} target="_blank" rel="noreferrer">View bill</a> : null}
        {canManage && e.status !== "CANCELLED" ? <AttachBill e={e} onDone={reload} /> : null}
      </span>
    </>
  );
}

type Row = {
  id: string; vendor: string; category: string; description: string; amount: number; input_gst: number; bill_day: string; due_day: string;
  status: string; overdue: boolean; method: string | null; paid_at: string | null; attachment_url: string | null;
};
const toExpense = (r: Row): Expense => ({
  id: r.id, vendor: r.vendor, category: r.category, description: r.description, amount: r.amount, inputGst: r.input_gst, billDate: r.bill_day,
  dueDate: r.due_day, status: r.status, overdue: r.overdue, method: r.method, paidAt: r.paid_at, attachmentUrl: r.attachment_url,
});

export function ExpensesList({ canManage }: { canManage: boolean }) {
  return (
    <FilteredList<Row>
      list="expenses"
      searchPlaceholder="Vendor or description"
      toolbar={canManage ? <NewExpenseButton /> : <span className="text-sm text-muted-foreground">View only</span>}
      columns={[
        { key: "vendor", header: "Vendor", cell: (r) => <BillCell e={toExpense(r)} canManage={canManage} /> },
        { key: "category", header: "Category", cell: (r) => <span className="text-sm">{label(r.category)}</span> },
        { key: "bill", header: "Bill date", cell: (r) => <RelTime className="text-sm" when={r.bill_day} /> },
        { key: "due", header: "Due", cell: (r) => <RelTime className={r.overdue ? "text-sm font-semibold text-destructive" : "text-sm"} when={r.due_day} /> },
        { key: "amount", header: "Amount", className: "text-right", cell: (r) => <Money paise={r.amount} /> },
        { key: "gst", header: "Input GST", className: "text-right", cell: (r) => <Money paise={r.input_gst} /> },
        { key: "status", header: "Status", cell: (r) => <span className="flex gap-1"><StatusBadge status={r.status} />{r.overdue ? <StatusBadge status="OVERDUE" /> : null}</span> },
        ...(canManage ? [{ key: "actions", header: "", cell: (r: Row) => <RowActions e={toExpense(r)} /> }] : []),
      ]}
      empty={{ title: "No expense bills match these filters", hint: "Supplier bills from goods receipts appear here too." }}
    />
  );
}
