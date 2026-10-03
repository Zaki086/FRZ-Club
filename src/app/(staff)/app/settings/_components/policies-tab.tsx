"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { assertNumbers, fromRupeeText, putSetting, SaveBar, toInt, toNum, toRupeeText, type SettingRow } from "./shared";

type Kind = "int" | "decimal" | "rupees";
type Scalar = { key: string; label: string; kind: Kind; hint?: string };

const GROUPS: Array<{ title: string; fields: Scalar[] }> = [
  {
    title: "Courts & booking",
    fields: [
      { key: "max_plays_per_day", label: "Max plays per member per day", kind: "int", hint: "BK-4 — every member player counts" },
      { key: "cancel_full_refund_hours", label: "Full refund if cancelled ≥ hours before", kind: "decimal", hint: "BK-7" },
      { key: "staff_grace_minutes", label: "Staff grace for a just-started slot (min)", kind: "int", hint: "BK-2 IN_PAST" },
      { key: "checkin_window_before_minutes", label: "Check-in opens before start (min)", kind: "int", hint: "CI-2" },
      { key: "social_default_capacity", label: "Social play capacity per court", kind: "int" },
      { key: "trial_fee", label: "Trial session fee (₹)", kind: "rupees", hint: "CR-8, paid at the desk" },
    ],
  },
  {
    title: "Shop",
    fields: [
      { key: "online_hold_minutes", label: "Online payment hold (min)", kind: "int", hint: "SH-5" },
      { key: "pickup_hold_hours", label: "Pay-at-pickup hold (hours)", kind: "int", hint: "SH-5" },
      { key: "default_reorder_level", label: "Default reorder level", kind: "int" },
      { key: "public_low_stock_threshold", label: "Show “Only N left” at or below", kind: "int", hint: "SH-8" },
      { key: "restring_turnaround_hours", label: "Restring turnaround (hours)", kind: "int", hint: "SH-12" },
    ],
  },
  {
    title: "Finance, CRM & reports",
    fields: [
      { key: "invoice_terms_days", label: "Default invoice payment terms (days)", kind: "int" },
      { key: "lead_follow_up_hours", label: "Lead follow-up within (hours)", kind: "int", hint: "CR-3" },
      { key: "quote_valid_days", label: "Quotes valid for (days)", kind: "int", hint: "CR-6" },
      { key: "share_link_days", label: "Share links expire after (days)", kind: "int", hint: "DB-5" },
      { key: "expiring_soon_days", label: "“Expiring soon” window (days)", kind: "int", hint: "MB-11" },
    ],
  },
];

function display(kind: Kind, v: unknown): string {
  const n = Number(v ?? 0);
  return kind === "rupees" ? toRupeeText(n) : String(n);
}
function parse(kind: Kind, s: string): number {
  return kind === "rupees" ? fromRupeeText(s) : kind === "decimal" ? toNum(s) : toInt(s);
}

export function PoliciesTab({ rows, onSaved }: { rows: SettingRow[]; onSaved: () => void }) {
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <OpeningHours value={get("opening_hours") as { open: string; close: string }} onSaved={onSaved} />
      <WalkIn value={get("walk_in") as WalkInValue} onSaved={onSaved} />
      {GROUPS.map((g) => (
        <Card key={g.title}>
          <CardHeader><CardTitle>{g.title}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {g.fields.map((f) => (
              <ScalarRow key={`${f.key}-${String(get(f.key))}`} field={f} value={get(f.key)} onSaved={onSaved} />
            ))}
          </CardContent>
        </Card>
      ))}
      <LeaveAllowance value={get("leave_allowance") as { CASUAL: number; SICK: number }} onSaved={onSaved} />
    </div>
  );
}

function ScalarRow({ field, value, onSaved }: { field: Scalar; value: unknown; onSaved: () => void }) {
  const [v, setV] = useState(display(field.kind, value));
  return (
    <div className="flex flex-wrap items-end gap-2 border-b pb-3 last:border-0">
      <Field label={field.label} hint={field.hint} className="min-w-56 flex-1">
        <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-label={field.label} />
      </Field>
      <SaveBar
        onSave={async () => {
          const n = parse(field.kind, v);
          assertNumbers({ [field.label]: n });
          await putSetting(field.key, n);
          onSaved();
        }}
      />
    </div>
  );
}

function OpeningHours({ value, onSaved }: { value: { open: string; close: string } | undefined; onSaved: () => void }) {
  const [open, setOpen] = useState(value?.open ?? "06:00");
  const [close, setClose] = useState(value?.close ?? "22:00");
  return (
    <Card>
      <CardHeader><CardTitle>Opening hours (every day, IST)</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Open"><Input type="time" step={1800} value={open} onChange={(e) => setOpen(e.target.value)} /></Field>
          <Field label="Close"><Input type="time" step={1800} value={close} onChange={(e) => setClose(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-muted-foreground">Sessions must start and end inside these hours (CT-2, CT-3).</p>
        <SaveBar onSave={async () => { await putSetting("opening_hours", { open, close }); onSaved(); }} />
      </CardContent>
    </Card>
  );
}

type WalkInValue = { court_fee: Record<string, number>; social_fee: number; shop_discount_pct: number; bar_discount_pct: number; advance_booking_days: number };
const SPORTS = ["TENNIS", "CRICKET", "PADEL", "BADMINTON"];

function WalkIn({ value, onSaved }: { value: WalkInValue | undefined; onSaved: () => void }) {
  const [f, setF] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(SPORTS.map((s) => [s, toRupeeText(value?.court_fee?.[s] ?? 0)])),
    social: toRupeeText(value?.social_fee ?? 0),
    shop: String(value?.shop_discount_pct ?? 0),
    bar: String(value?.bar_discount_pct ?? 0),
    days: String(value?.advance_booking_days ?? 1),
  }));
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card>
      <CardHeader><CardTitle>Walk-in tier (guests and expired members)</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SPORTS.map((s) => (
            <Field key={s} label={`${s.charAt(0)}${s.slice(1).toLowerCase()} ₹/player/h`}>
              <Input inputMode="decimal" value={f[s]} onChange={set(s)} />
            </Field>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="Social fee ₹"><Input inputMode="decimal" value={f.social} onChange={set("social")} /></Field>
          <Field label="Shop discount %"><Input inputMode="numeric" value={f.shop} onChange={set("shop")} /></Field>
          <Field label="Bar discount %"><Input inputMode="numeric" value={f.bar} onChange={set("bar")} /></Field>
          <Field label="Advance booking days"><Input inputMode="numeric" value={f.days} onChange={set("days")} /></Field>
        </div>
        <SaveBar
          onSave={async () => {
            const value = {
              court_fee: Object.fromEntries(SPORTS.map((s) => [s, fromRupeeText(f[s])])),
              social_fee: fromRupeeText(f.social), shop_discount_pct: toInt(f.shop), bar_discount_pct: toInt(f.bar), advance_booking_days: toInt(f.days),
            };
            assertNumbers({ ...value.court_fee, social: value.social_fee, shop: value.shop_discount_pct, bar: value.bar_discount_pct, days: value.advance_booking_days });
            await putSetting("walk_in", value);
            onSaved();
          }}
        />
      </CardContent>
    </Card>
  );
}

function LeaveAllowance({ value, onSaved }: { value: { CASUAL: number; SICK: number } | undefined; onSaved: () => void }) {
  const [casual, setCasual] = useState(String(value?.CASUAL ?? 12));
  const [sick, setSick] = useState(String(value?.SICK ?? 6));
  return (
    <Card>
      <CardHeader><CardTitle>Staff leave allowance (per calendar year)</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Casual days"><Input inputMode="numeric" value={casual} onChange={(e) => setCasual(e.target.value)} /></Field>
          <Field label="Sick days"><Input inputMode="numeric" value={sick} onChange={(e) => setSick(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-muted-foreground">Requests beyond the allowance must be unpaid (ST-5).</p>
        <SaveBar
          onSave={async () => {
            const v = { CASUAL: toInt(casual), SICK: toInt(sick) };
            assertNumbers(v);
            await putSetting("leave_allowance", v);
            onSaved();
          }}
        />
      </CardContent>
    </Card>
  );
}
