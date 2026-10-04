"use client";
// v5 §1.3 (ORDER), Owner only: member orders from the portal "Bar & Café" — MO-4 auto-accept for table scans, MO-5 the
// member tab limit, MO-3 when a waiting order turns red on the bar screen. Until saved, the server's defaults apply
// (off, ₹3,000, 5 minutes) and are shown here.
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { assertNumbers, fromRupeeText, putSetting, SaveBar, toInt, toRupeeText, type SettingRow } from "./shared";

const DEFAULTS = { auto_accept_member_orders: false, member_tab_limit: 300_000, member_order_accept_minutes: 5 } as const;

export function BarOrdersSettings({ rows, onSaved }: { rows: SettingRow[]; onSaved: () => void }) {
  const val = (k: keyof typeof DEFAULTS): unknown => rows.find((r) => r.key === k)?.value ?? DEFAULTS[k];
  const [auto, setAuto] = useState(val("auto_accept_member_orders") === true);
  const [limit, setLimit] = useState(toRupeeText(Number(val("member_tab_limit"))));
  const [minutes, setMinutes] = useState(String(val("member_order_accept_minutes")));
  return (
    <Card data-testid="bar-orders-settings">
      <CardHeader><CardTitle>Bar &amp; Café member orders</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={auto} onChange={(e) => setAuto(e.target.checked)} aria-label="Auto-accept member orders" />
          <span>
            <span className="font-semibold">Auto-accept member orders</span>
            <span className="block text-xs text-muted-foreground">MO-4 — orders from members who scanned their table&apos;s QR go straight to the kitchen. Orders placed with only a check-in still wait for the bar.</span>
          </span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Member tab limit (₹)" hint="MO-5 — app orders stop when the member would owe more than this">
            <Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Member tab limit (₹)" />
          </Field>
          <Field label="Incoming order turns red after (min)" hint="MO-3">
            <Input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Incoming order turns red after (min)" />
          </Field>
        </div>
        <SaveBar
          onSave={async () => {
            const tabLimit = fromRupeeText(limit);
            const accept = toInt(minutes);
            assertNumbers({ "Member tab limit": tabLimit, "Turns red after": accept });
            await putSetting("auto_accept_member_orders", auto);
            await putSetting("member_tab_limit", tabLimit);
            await putSetting("member_order_accept_minutes", accept);
            onSaved();
          }}
        />
      </CardContent>
    </Card>
  );
}
