"use client";
// Completion pass §3: WhatsApp without an API — the server writes the message from the record and logs it, then
// WhatsApp opens with the text ready for staff to send from the club's phone.
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { api, ApiError } from "./api";
import { Button } from "./ui/button";

export type WhatsAppTarget =
  | { template: "BOOKING"; bookingId: string }
  | { template: "MEMBERSHIP"; memberId: string }
  | { template: "ORDER"; orderId: string }
  | { template: "INVOICE"; invoiceId: string }
  | { template: "LEAD"; leadId: string };

export function WhatsAppButton({ target, label = "WhatsApp", size = "sm" }: { target: WhatsAppTarget; label?: string; size?: "sm" | "default" }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size={size}
        onClick={async () => {
          setError(null);
          // Open the window first (inside the click) so pop-up blockers allow it, then point it at wa.me.
          const w = window.open("", "_blank");
          try {
            const r = await api<{ url: string }>("/api/messages/whatsapp", { body: target });
            if (w) w.location.href = r.url;
            else window.location.href = r.url;
          } catch (e) {
            w?.close();
            setError(e instanceof ApiError ? e.message : String(e));
          }
        }}
      >
        <MessageCircle className="h-4 w-4" /> {label}
      </Button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
