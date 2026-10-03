"use client";
// Completion pass §1: what the club can really do, and the switches behind it. A capability that is off is not
// offered anywhere in the app; the reason column says exactly what is missing.
import { useState } from "react";
import { api, useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { loadCapabilities } from "@/components/capabilities";
import { fromRupeeText, putSetting, SaveBar, toRupeeText, type SettingRow } from "./shared";

type Status = Record<string, { enabled: boolean; reason: string }>;

const LABEL: Record<string, string> = {
  "payments.cash": "Cash at the counter",
  "payments.card": "Card (club terminal)",
  "payments.upi": "UPI (club QR)",
  "payments.online": "Online payment (Razorpay)",
  email: "Email",
  delivery: "Shop delivery",
  gst: "GST invoices",
  "photos.upload": "Photo uploads",
  push: "Push notifications",
  "whatsapp.api": "WhatsApp (automatic, Cloud API)",
};

const EVENTS: Array<[string, string]> = [
  ["MEMBERSHIP_WELCOME", "Welcome with login link"], ["MEMBERSHIP_RENEWED", "Membership confirmed"], ["MEMBERSHIP_EXPIRY", "Expiry reminder"],
  ["DUES_REMINDER", "Dues reminder"], ["REFUND_COMPLETED", "Refund paid"], ["CREDENTIALS_REISSUED", "New login link"], ["BOOKING_CANCELLED_BY_CLUB", "Cancelled by the club"],
];

/** v3 §6.3: approved WhatsApp templates per message and a test message; without them WhatsApp stays manual. */
function WhatsAppCard({ rows, saved }: { rows: SettingRow[]; saved: () => void }) {
  const current = (rows.find((r) => r.key === "whatsapp_templates")?.value ?? {}) as Record<string, { name: string; language: string }>;
  const [names, setNames] = useState<Record<string, string>>(Object.fromEntries(EVENTS.map(([k]) => [k, current[k]?.name ?? ""])));
  const [lang, setLang] = useState(Object.values(current)[0]?.language ?? "en");
  const [to, setTo] = useState("");
  return (
    <Card>
      <CardHeader><CardTitle>WhatsApp messages</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          Automatic WhatsApp needs WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET in the server&apos;s .env, a template approved by Meta for each message, and a test message. Meta charges per message. Until then, messages wait under “Messages to send” for the desk to send from the club phone.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {EVENTS.map(([k, label]) => (
            <Field key={k} label={label}><Input value={names[k]} onChange={(e) => setNames({ ...names, [k]: e.target.value })} placeholder="approved template name" /></Field>
          ))}
          <Field label="Template language code"><Input value={lang} onChange={(e) => setLang(e.target.value)} /></Field>
        </div>
        <SaveBar label="Save templates" onSave={async () => {
          await putSetting("whatsapp_templates", Object.fromEntries(Object.entries(names).filter(([, v]) => v.trim()).map(([k, v]) => [k, { name: v.trim(), language: lang.trim() }])));
          saved();
        }} />
        <Field label="Send a test message to (mobile)"><Input inputMode="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="98765 43210" /></Field>
        <SaveBar label="Send test WhatsApp" onSave={async () => { await api("/api/messages/test-whatsapp", { body: { to } }); saved(); }} />
      </CardContent>
    </Card>
  );
}

export function PaymentsTab({ rows, onSaved }: { rows: SettingRow[]; onSaved: () => void }) {
  const status = useApi<Status>("/api/capabilities/status");
  const pm = (rows.find((r) => r.key === "payment_methods")?.value ?? { card_enabled: false, upi_vpa: "", upi_confirmed: false }) as { card_enabled: boolean; upi_vpa: string; upi_confirmed: boolean };
  const dl = (rows.find((r) => r.key === "delivery")?.value ?? { enabled: false, pincodes: [], fee: 9900 }) as { enabled: boolean; pincodes: string[]; fee: number };
  const [card, setCard] = useState(pm.card_enabled);
  const [vpa, setVpa] = useState(pm.upi_vpa);
  const [confirmed, setConfirmed] = useState(pm.upi_confirmed);
  const [delivery, setDelivery] = useState(dl.enabled);
  const [pins, setPins] = useState(dl.pincodes.join(", "));
  const [fee, setFee] = useState(toRupeeText(dl.fee));
  const [testTo, setTestTo] = useState("");
  const saved = () => {
    void loadCapabilities(true);
    void status.reload();
    onSaved();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>What the club can do right now</CardTitle></CardHeader>
        <CardContent>
          <DataState state={status}>
            {(s) => (
              <div className="divide-y text-sm" data-testid="capability-status">
                {Object.entries(s).map(([k, v]) => (
                  <div key={k} className="flex items-start justify-between gap-3 py-2" data-testid={`cap-${k}`}>
                    <div>
                      <p className="font-medium">{LABEL[k] ?? k}</p>
                      <p className="text-xs text-muted-foreground">{v.reason}</p>
                    </div>
                    <Badge tone={v.enabled ? "green" : "neutral"}>{v.enabled ? "On" : "Off"}</Badge>
                  </div>
                ))}
              </div>
            )}
          </DataState>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader><CardTitle>Counter payments</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={card} onChange={(e) => setCard(e.target.checked)} /> The club has a working card machine</label>
            <Field label="Club UPI ID" hint="e.g. clubname@okhdfcbank — the QR shown to customers pays this ID">
              <Input value={vpa} onChange={(e) => { setVpa(e.target.value.trim()); setConfirmed(false); }} />
            </Field>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={confirmed} disabled={!vpa} onChange={(e) => setConfirmed(e.target.checked)} />
              I sent a test payment to this UPI ID and it arrived in the club&apos;s account.
            </label>
            <SaveBar onSave={async () => { await putSetting("payment_methods", { card_enabled: card, upi_vpa: vpa, upi_confirmed: confirmed && !!vpa }); saved(); }} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Email</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              Email needs SMTP_HOST and SMTP_FROM in the server&apos;s .env. Send a test email: once it arrives, the app starts emailing receipts, reminders and quotes.
            </p>
            <Field label="Send the test to"><Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="your email" /></Field>
            <SaveBar label="Send test email" onSave={async () => { await api("/api/messages/test-email", { body: { to: testTo || undefined } }); saved(); }} />
          </CardContent>
        </Card>
        <WhatsAppCard rows={rows} saved={saved} />
        <Card>
          <CardHeader><CardTitle>Shop delivery</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} /> The club delivers orders</label>
            <Field label="PIN codes served" hint="Comma-separated 6-digit PIN codes"><Input value={pins} onChange={(e) => setPins(e.target.value)} /></Field>
            <Field label="Delivery fee (₹)" hint="Never discounted (PR-5)"><Input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
            <SaveBar
              onSave={async () => {
                const pincodes = pins.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
                const f = fromRupeeText(fee);
                if (Number.isNaN(f)) throw new Error("Enter a valid delivery fee.");
                await putSetting("delivery", { enabled: delivery, pincodes, fee: f });
                saved();
              }}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
