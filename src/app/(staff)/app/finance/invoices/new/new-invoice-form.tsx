"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { RejectionBanner } from "@/components/states";
import { parseRupees } from "@/lib/money";

type Client = { id: string; name: string; gstin: string | null; stateCode: string };
type MemberHit = { id: string; name: string; memberCode: string; phone: string };
type Product = { id: string; name: string; variants: Array<{ id: string; label: string; sku: string }> };
type Line =
  | { kind: "MANUAL"; description: string; qty: string; unitPrice: string; taxCategory: string }
  | { kind: "CATALOGUE"; variantId: string; qty: string };

const TAX_CATEGORIES = ["BUSINESS_SERVICE", "COURT", "MEMBERSHIP", "GOODS", "SERVICE", "RESTAURANT", "DELIVERY"];

export function NewInvoiceForm({ initialClientId }: { initialClientId: string }) {
  const router = useRouter();
  const clients = useApi<Client[]>("/api/clients");
  const catalogue = useApi<Product[]>("/api/shop/catalogue");
  const [customerKind, setCustomerKind] = useState<"CLIENT" | "MEMBER">("CLIENT");
  const [clientId, setClientId] = useState(initialClientId);
  const [memberQ, setMemberQ] = useState("");
  const [member, setMember] = useState<MemberHit | null>(null);
  const hits = useApi<MemberHit[]>(customerKind === "MEMBER" && !member && memberQ.trim().length >= 2 ? `/api/members?q=${encodeURIComponent(memberQ.trim())}` : null);
  const [lines, setLines] = useState<Line[]>([{ kind: "MANUAL", description: "", qty: "1", unitPrice: "", taxCategory: "BUSINESS_SERVICE" }]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? ({ ...l, ...patch } as Line) : l)));
  const variants = (catalogue.data ?? []).flatMap((p) => p.variants.map((v) => ({ id: v.id, label: `${p.name}${v.label !== "Standard" ? ` — ${v.label}` : ""} (${v.sku})` })));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const payloadLines = lines.map((l) => {
            const qty = Number(l.qty);
            if (!Number.isInteger(qty) || qty <= 0) throw new ApiError("VALIDATION_FAILED", "Every line needs a whole-number quantity.", 422, null);
            if (l.kind === "CATALOGUE") {
              if (!l.variantId) throw new ApiError("VALIDATION_FAILED", "Pick a product for every catalogue line.", 422, null);
              return { kind: "CATALOGUE" as const, variantId: l.variantId, qty };
            }
            const unitPrice = parseRupees(l.unitPrice);
            if (unitPrice === null) throw new ApiError("VALIDATION_FAILED", "Enter a valid price (₹) for every manual line.", 422, null);
            return { kind: "MANUAL" as const, description: l.description, qty, unitPrice, taxCategory: l.taxCategory };
          });
          setBusy(true);
          const r = await api<{ invoice: { id: string } }>("/api/invoices", {
            body: {
              businessClientId: customerKind === "CLIENT" ? clientId || undefined : undefined,
              memberId: customerKind === "MEMBER" ? member?.id : undefined,
              lines: payloadLines,
              notes: notes || undefined,
            },
          });
          router.push(`/app/finance/invoices/${r.invoice.id}`);
        } catch (err) {
          setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
          setBusy(false);
        }
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Bill to</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={customerKind === "CLIENT" ? "default" : "outline"} onClick={() => setCustomerKind("CLIENT")}>
              Business client
            </Button>
            <Button type="button" size="sm" variant={customerKind === "MEMBER" ? "default" : "outline"} onClick={() => setCustomerKind("MEMBER")}>
              Member
            </Button>
          </div>
          {customerKind === "CLIENT" ? (
            <Field label="Client">
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)} required>
                <option value="">Choose a client…</option>
                {(clients.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.gstin ? `· ${c.gstin}` : "· no GSTIN"}
                  </option>
                ))}
              </Select>
            </Field>
          ) : member ? (
            <div className="flex items-center justify-between rounded-md border p-2 text-sm">
              <span>
                {member.name} <span className="font-mono text-xs text-muted-foreground">{member.memberCode}</span>
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setMember(null)}>
                Change
              </Button>
            </div>
          ) : (
            <Field label="Find member">
              <Input value={memberQ} onChange={(e) => setMemberQ(e.target.value)} placeholder="Name, phone or CC-000123" />
              {(hits.data ?? []).length ? (
                <div className="mt-1 divide-y rounded-md border">
                  {hits.data!.map((m) => (
                    <button type="button" key={m.id} className="block w-full p-2 text-left text-sm hover:bg-muted" onClick={() => setMember(m)}>
                      {m.name} · {m.memberCode} · {m.phone}
                    </button>
                  ))}
                </div>
              ) : null}
            </Field>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-md border p-2">
              {l.kind === "MANUAL" ? (
                <>
                  <Field label="Description" className="col-span-12 sm:col-span-5">
                    <Input value={l.description} onChange={(e) => update(i, { description: e.target.value })} placeholder="Corporate court package — October" required />
                  </Field>
                  <Field label="Qty" className="col-span-3 sm:col-span-1">
                    <Input inputMode="numeric" value={l.qty} onChange={(e) => update(i, { qty: e.target.value })} />
                  </Field>
                  <Field label="Unit price ₹ (GST incl.)" className="col-span-5 sm:col-span-3">
                    <Input inputMode="decimal" value={l.unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value })} required />
                  </Field>
                  <Field label="Tax category" className="col-span-4 sm:col-span-2">
                    <Select value={l.taxCategory} onChange={(e) => update(i, { taxCategory: e.target.value })}>
                      {TAX_CATEGORIES.map((t) => (
                        <option key={t} value={t}>
                          {t.replace("_", " ").toLowerCase()}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Catalogue item (priced by the server)" className="col-span-9 sm:col-span-10">
                    <Select value={l.variantId} onChange={(e) => update(i, { variantId: e.target.value })} required>
                      <option value="">Choose a product…</option>
                      {variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Qty" className="col-span-2 sm:col-span-1">
                    <Input inputMode="numeric" value={l.qty} onChange={(e) => update(i, { qty: e.target.value })} />
                  </Field>
                </>
              )}
              <Button type="button" variant="ghost" size="icon" className="col-span-1" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, { kind: "MANUAL", description: "", qty: "1", unitPrice: "", taxCategory: "BUSINESS_SERVICE" }])}>
              <Plus className="h-4 w-4" /> Manual line
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, { kind: "CATALOGUE", variantId: "", qty: "1" }])}>
              <Plus className="h-4 w-4" /> Catalogue line
            </Button>
          </div>
          <Field label="Notes (printed on the invoice)">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <RejectionBanner error={error} />
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Creating draft…" : "Create draft invoice"}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
