"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { parseRupees } from "@/lib/money";
import type { MenuItem } from "../_components/types";

const errOf = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

function PriceEditor({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const [price, setPrice] = useState((item.price / 100).toFixed(0));
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex gap-1">
        <Input className="h-8 w-24" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label={`Price of ${item.name}`} />
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            setError(null);
            const p = parseRupees(price);
            if (p === null) return setError({ message: "Enter a valid price." });
            try { await api(`/api/bar/menu/${item.id}`, { method: "PATCH", body: { price: p } }); onDone(); }
            catch (e) { setError(errOf(e)); }
          }}
        >
          Save
        </Button>
      </span>
      <RejectionBanner error={error} />
    </span>
  );
}

export function MenuManager() {
  const menu = useApi<MenuItem[]>("/api/bar/menu?all=1");
  const [f, setF] = useState({ name: "", category: "FOOD" as MenuItem["category"], price: "" });
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader><CardTitle>Add an item</CardTitle></CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-4">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Category">
            <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as MenuItem["category"] })}>
              <option value="FOOD">Food</option>
              <option value="BEVERAGE">Drink (non-alcoholic)</option>
              <option value="ALCOHOL">Alcohol</option>
            </Select>
          </Field>
          <Field label="Price (₹)"><Input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          <div className="flex items-end">
            <Button
              onClick={async () => {
                setError(null);
                const price = parseRupees(f.price);
                if (price === null) return setError({ message: "Enter a valid price." });
                try {
                  await api("/api/bar/menu", { body: { name: f.name, category: f.category, price, isAlcoholic: f.category === "ALCOHOL" } });
                  setF({ name: "", category: f.category, price: "" });
                  await menu.reload();
                } catch (e) {
                  setError(errOf(e));
                }
              }}
            >
              Add item
            </Button>
          </div>
          <div className="sm:col-span-4"><RejectionBanner error={error} /></div>
        </CardContent>
      </Card>
      <DataState state={menu}>
        {(items) => (
          <Card>
            <CardContent className="divide-y pt-4 text-sm">
              {items.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{m.name}</span>{" "}
                    <Badge tone="neutral">{m.category.toLowerCase()}</Badge>{" "}
                    {m.available ? null : <Badge tone="amber">sold out</Badge>}
                    <span className="ml-2 text-muted-foreground"><Money paise={m.price} /></span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <PriceEditor item={m} onDone={() => void menu.reload()} />
                    <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/bar/menu/${m.id}`, { method: "PATCH", body: { available: !m.available } }); await menu.reload(); }}>
                      {m.available ? "Mark sold out" : "Back on"}
                    </Button>
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </DataState>
    </div>
  );
}
