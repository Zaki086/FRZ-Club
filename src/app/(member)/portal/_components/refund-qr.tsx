"use client";
// v4 RF-8 / §3.4: "Show QR" — the signed collection QR of each refund waiting at the desk, to show on the phone.
// The same value opens /rq/<token> (the page the WhatsApp button links to).
import Link from "next/link";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { formatINR } from "@/lib/money";

type Waiting = { id: string; code: string; toCollect: number; amount: number; token: string | null; forName?: string | null };

function Qr({ value, alt }: { value: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: 260, errorCorrectionLevel: "M" })
      .then((d) => !cancelled && setSrc(d))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [value]);
  // eslint-disable-next-line @next/next/no-img-element -- generated data URL
  return src ? <img src={src} alt={alt} width={240} height={240} className="mx-auto rounded-xl border bg-white p-2" /> : <div className="mx-auto h-60 w-60 animate-pulse rounded-xl bg-muted" />;
}

export function RefundQrButton({ refunds, label = "Show QR" }: { refunds: Waiting[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const shown = refunds.filter((r): r is Waiting & { token: string } => !!r.token);
  if (!shown.length) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}><QrCode className="h-4 w-4" /> {label}</Button>
      <DialogContent title="Show this at the front desk" description="The desk scans the QR (or your member card) and hands you the cash.">
        <div className="flex flex-col gap-6" data-testid="refund-qr-dialog">
          {shown.map((r) => (
            <div key={r.id} className="flex flex-col items-center gap-1 text-center">
              <Qr value={r.token} alt={`Refund QR for ${r.code}`} />
              <p className="font-mono text-lg font-bold">{r.code}</p>
              <p className="text-sm">{formatINR(r.toCollect || r.amount)}{r.forName ? ` · ${r.forName}` : ""}</p>
              <Link href={`/rq/${encodeURIComponent(r.token)}`} target="_blank" className="text-xs font-semibold text-primary underline">Open full screen</Link>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
