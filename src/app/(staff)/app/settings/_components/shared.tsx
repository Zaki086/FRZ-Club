"use client";
import { useState } from "react";
import { Check } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { Button } from "@/components/ui/button";
import { RejectionBanner } from "@/components/states";
import { parseRupees } from "@/lib/money";

export type SettingRow = { key: string; value: unknown; verified: boolean; updatedAt: string };

/** ₹ text ⇄ paise. Returns NaN when the text is not a valid rupee amount. */
export const toRupeeText = (paise: number) => (paise / 100).toFixed(paise % 100 ? 2 : 0);
export function fromRupeeText(s: string): number {
  const v = parseRupees(s);
  return v === null ? NaN : v;
}
export function toInt(s: string): number {
  return /^-?\d+$/.test(s.trim()) ? Number(s.trim()) : NaN;
}
export function toNum(s: string): number {
  return /^\d+(\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : NaN;
}

/** Save button with server-message display (validation errors shown verbatim). */
export function SaveBar({ onSave, disabled, label = "Save" }: { onSave: () => Promise<unknown>; disabled?: boolean; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <RejectionBanner error={error} />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || disabled}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setSaved(false);
            try {
              await onSave();
              setSaved(true);
            } catch (e) {
              setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: e instanceof Error ? e.message : String(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : label}
        </Button>
        {saved ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-700">
            <Check className="h-3 w-3" /> Saved
          </span>
        ) : null}
      </div>
    </div>
  );
}

export async function putSetting(key: string, value: unknown) {
  return api(`/api/settings/${key}`, { method: "PUT", body: { value } });
}

/** Throws a readable error when any parsed number is invalid (client-side guard; the server validates again). */
export function assertNumbers(fields: Record<string, number>) {
  const bad = Object.entries(fields).filter(([, v]) => Number.isNaN(v));
  if (bad.length) throw new Error(`Please enter a valid number for: ${bad.map(([k]) => k).join(", ")}.`);
}
