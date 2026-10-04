"use client";
// v6 §2 (SENDALL), Owner only: SA-3 the age limit of manual WhatsApp tasks (older → EXPIRED, left out of "Send all")
// and SA-4 when a manual WhatsApp task is created at all. Until saved, the defaults apply (7 days, only when no other
// channel reaches the person). Automatic WhatsApp itself is only ever the official Cloud API (SA-0).
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { assertNumbers, putSetting, SaveBar, toInt, type SettingRow } from "./shared";

const MODES = [
  { value: "ONLY_IF_NO_OTHER_CHANNEL", label: "Only when no other channel reaches them" },
  { value: "ALWAYS", label: "Always (also when push or email reached them)" },
  { value: "NEVER", label: "Never" },
] as const;

export function ManualMessagesSettings({ rows, onSaved }: { rows: SettingRow[]; onSaved: () => void }) {
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const [days, setDays] = useState(String(get("manual_message_max_age_days") ?? 7));
  const [mode, setMode] = useState(String(get("manual_whatsapp_fallback") ?? "ONLY_IF_NO_OTHER_CHANNEL"));
  return (
    <Card data-testid="manual-messages-settings">
      <CardHeader><CardTitle>Manual WhatsApp messages</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field label="Create a manual WhatsApp task" hint="SA-4">
          <select className="h-10 rounded-md border bg-background px-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Create a manual WhatsApp task">
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Messages expire after (days)" hint="SA-3">
          <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Messages expire after (days)" />
        </Field>
        <SaveBar
          onSave={async () => {
            const n = toInt(days);
            assertNumbers({ "Messages expire after": n });
            await putSetting("manual_whatsapp_fallback", mode);
            await putSetting("manual_message_max_age_days", n);
            onSaved();
          }}
        />
      </CardContent>
    </Card>
  );
}
