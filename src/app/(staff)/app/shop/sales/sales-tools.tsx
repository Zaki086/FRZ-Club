"use client";
// v6 §4.2 on Counter Sales: WI-1 "New sale" (the counter POS with its walk-in switch — the Manager sells from here)
// and WI-5 "Find receipt": the receipt code typed in or the receipt QR scanned finds the sale (an anonymous walk-in
// sale has no person to search for), filtered in the list for its return.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, QrCode, X } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { QrScanner } from "@/components/qr-scanner";
import { RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CounterPos } from "../_components/pos";

export function NewSale() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Button className="self-start" variant={open ? "outline" : "default"} onClick={() => setOpen(!open)} data-testid="new-counter-sale">
        {open ? <><X className="h-4 w-4" /> Close the till</> : <><Plus className="h-4 w-4" /> New sale</>}
      </Button>
      {open ? <CounterPos /> : null}
    </div>
  );
}

export function FindReceipt() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [scan, setScan] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const find = async (t: string) => {
    setError(null);
    try {
      const sale = await api<{ code: string }>(`/api/shop/receipt?text=${encodeURIComponent(t.trim())}`);
      setText("");
      router.push(`/app/shop/sales?q=${encodeURIComponent(sale.code)}&sort=newest`);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void find(text); }}>
        <Input className="w-44" placeholder="Receipt code" aria-label="Receipt code" value={text} onChange={(e) => setText(e.target.value)} data-testid="find-receipt" />
        <Button type="submit" variant="outline" disabled={!text.trim()}>Find</Button>
        <Button type="button" variant="outline" onClick={() => setScan(true)}><QrCode className="h-4 w-4" /> Scan receipt</Button>
      </form>
      {scan ? <QrScanner onScan={(t) => { setScan(false); void find(t); }} onClose={() => setScan(false)} /> : null}
      <RejectionBanner error={error} />
    </div>
  );
}
