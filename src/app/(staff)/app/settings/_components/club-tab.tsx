"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { putSetting, SaveBar, type SettingRow } from "./shared";

const FIELDS: Array<{ key: string; label: string; hint?: string }> = [
  { key: "name", label: "Club name" },
  { key: "legal_name", label: "Legal name (on invoices)" },
  { key: "address", label: "Address" },
  { key: "state", label: "State" },
  { key: "state_code", label: "State code", hint: "2 digits — decides CGST/SGST vs IGST (IN-3)" },
  { key: "gstin", label: "GSTIN" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "upi_vpa", label: "UPI ID for counter QR", hint: "E-14" },
];

export function ClubTab({ rows, onSaved }: { rows: SettingRow[]; onSaved: () => void }) {
  const club = (rows.find((r) => r.key === "club")?.value ?? {}) as Record<string, string>;
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((x) => [x.key, club[x.key] ?? ""])));
  return (
    <Card className="max-w-3xl">
      <CardHeader><CardTitle>Club details</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map((x) => (
            <Field key={x.key} label={x.label} hint={x.hint}>
              <Input value={f[x.key]} onChange={(e) => setF({ ...f, [x.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        <SaveBar onSave={async () => { await putSetting("club", f); onSaved(); }} />
      </CardContent>
    </Card>
  );
}
