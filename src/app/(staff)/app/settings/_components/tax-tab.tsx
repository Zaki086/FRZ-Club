"use client";
import { useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { api } from "@/components/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { assertNumbers, putSetting, SaveBar, toInt, type SettingRow } from "./shared";

const RATE_LABEL: Record<string, string> = {
  COURT: "Court & social play", MEMBERSHIP: "Memberships", GOODS: "Shop goods", SERVICE: "Shop services (restringing)",
  RESTAURANT: "Food & soft drinks", ALCOHOL: "Alcohol (outside GST)", DELIVERY: "Delivery", BUSINESS_SERVICE: "Business invoices",
};
const SAC_LABEL: Record<string, string> = { COURT: "Courts", MEMBERSHIP: "Memberships", DELIVERY: "Delivery", BUSINESS_SERVICE: "Business invoices" };

export function TaxTab({ rows, onSaved }: { rows: SettingRow[]; onSaved: () => void }) {
  const tax = rows.find((r) => r.key === "tax_rates");
  const sac = rows.find((r) => r.key === "sac_codes");
  const rates = (tax?.value ?? {}) as Record<string, number>;
  const codes = (sac?.value ?? {}) as Record<string, string>;
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(RATE_LABEL).map((k) => [k, String(rates[k] ?? 0)])));
  const [s, setS] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(SAC_LABEL).map((k) => [k, codes[k] ?? ""])));
  return (
    <div className="flex flex-col gap-4">
      {tax && !tax.verified ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-amber-900" role="alert">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">Rates not verified — check current GST rates</p>
              <p className="text-sm">These are seeded placeholders. Confirm each rate with your tax advisor, edit if needed, then mark them as verified (IN-6).</p>
            </div>
          </div>
          <SaveBar label="Mark as verified" onSave={async () => { await api("/api/settings/tax_rates", { body: {} }); onSaved(); }} />
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900">
          <ShieldCheck className="h-4 w-4" /> GST rates have been verified by the owner.
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>GST rate by category (%)</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(RATE_LABEL).map(([k, label]) => (
                <Field key={k} label={label}>
                  <Input inputMode="numeric" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
            <SaveBar
              onSave={async () => {
                const v = Object.fromEntries(Object.keys(RATE_LABEL).map((k) => [k, toInt(f[k])]));
                assertNumbers(v);
                await putSetting("tax_rates", v);
                onSaved();
              }}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>SAC codes</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(SAC_LABEL).map(([k, label]) => (
                <Field key={k} label={label}>
                  <Input value={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
            <SaveBar onSave={async () => { await putSetting("sac_codes", s); onSaved(); }} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
