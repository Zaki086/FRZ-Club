"use client";
import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { putSetting, SaveBar, type SettingRow } from "./shared";
import { EmailInput, PhoneInput, requireContactInputs } from "@/components/contact-inputs";
import { formatPhone } from "@/lib/validation/contact";

const FIELDS: Array<{ key: string; label: string; hint?: string }> = [
  { key: "name", label: "Club name" },
  { key: "legal_name", label: "Legal name (on invoices)" },
  { key: "address", label: "Address" },
  { key: "state", label: "State" },
  { key: "state_code", label: "State code", hint: "2 digits — decides CGST/SGST vs IGST (IN-3)" },
  { key: "gstin", label: "GSTIN", hint: "Leave empty if the club is not GST-registered — then no GST is charged" },
  { key: "phone", label: "Phone", hint: "Mobile or landline with STD code" },
  { key: "email", label: "Email" },
];

export function ClubTab({ rows, onSaved }: { rows: SettingRow[]; onSaved: () => void }) {
  const club = (rows.find((r) => r.key === "club")?.value ?? {}) as Record<string, string>;
  // v5 CV-3: the phone is stored as 10 digits and shown formatted.
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((x) => [x.key, x.key === "phone" && club.phone ? formatPhone(club.phone) : (club[x.key] ?? "")])));
  const fields = useRef<HTMLDivElement>(null);
  return (
    <Card className="max-w-3xl">
      <CardHeader><CardTitle>Club details</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div ref={fields} className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map((x) => {
            const props = { name: x.key, value: f[x.key], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [x.key]: e.target.value }) };
            return (
              <Field key={x.key} label={x.label} hint={x.hint}>
                {x.key === "phone" ? <PhoneInput kind="contact" {...props} /> : x.key === "email" ? <EmailInput {...props} /> : <Input {...props} />}
              </Field>
            );
          })}
        </div>
        <SaveBar onSave={async () => { requireContactInputs(fields.current); await putSetting("club", f); onSaved(); }} />
      </CardContent>
    </Card>
  );
}
