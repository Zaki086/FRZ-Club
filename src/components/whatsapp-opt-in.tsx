"use client";
// v4 §5.1: WhatsApp consent is its own, unticked box on the sign-up, trial and enquiry forms (separate from the
// privacy consent). Without it, nothing is sent to the person automatically on WhatsApp.
import { InfoTip } from "./info-tip";

export const WHATSAPP_OPT_IN_LABEL = "Send me booking and refund updates on WhatsApp";

/** v6 UI-2: the guidance (and a form's own `hint`) sits in the ⓘ next to the box, not under it. */
export function WhatsAppOptIn({ checked, onChange, hint }: { checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="flex items-start gap-1 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="whatsapp-opt-in" />
        <span>{WHATSAPP_OPT_IN_LABEL}</span>
      </label>
      <InfoTip place="whatsapp-opt-in" label="About WhatsApp updates">
        {hint ? <span className="mb-1 block font-semibold">{hint}</span> : null}
        Leave it unticked unless the person agrees: without it nothing is sent to them automatically on WhatsApp. They can reply STOP at any time.
      </InfoTip>
    </div>
  );
}
