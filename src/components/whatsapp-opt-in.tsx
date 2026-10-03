"use client";
// v4 §5.1: WhatsApp consent is its own, unticked box on the sign-up, trial and enquiry forms (separate from the
// privacy consent). Without it, nothing is sent to the person automatically on WhatsApp.
export const WHATSAPP_OPT_IN_LABEL = "Send me booking and refund updates on WhatsApp";

export function WhatsAppOptIn({ checked, onChange, hint }: { checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="whatsapp-opt-in" />
      <span>
        {WHATSAPP_OPT_IN_LABEL}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}
