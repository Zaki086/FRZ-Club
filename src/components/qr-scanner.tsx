"use client";
import { useEffect, useId, useState } from "react";
import { Button } from "./ui/button";

/** Webcam QR scanner (html5-qrcode). USB/handheld scanners can also type the payload into a search box. */
export function QrScanner({ onScan, onClose }: { onScan: (text: string) => void; onClose: () => void }) {
  const id = `qr-${useId().replace(/:/g, "")}`;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let scanner: { stop: () => Promise<void>; clear: () => void } | null = null;
    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        const s = new Html5Qrcode(id);
        scanner = s;
        await s.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          (text) => {
            if (stopped) return;
            stopped = true;
            onScan(text);
          },
          () => undefined,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Camera unavailable. Type or scan the code into the search box instead.");
      }
    })();
    return () => {
      stopped = true;
      if (scanner) scanner.stop().then(() => scanner?.clear()).catch(() => undefined);
    };
  }, [onScan, id]);
  return (
    <div className="flex flex-col gap-2">
      <div id={id} className="mx-auto w-full max-w-sm overflow-hidden rounded-lg bg-black" />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button variant="outline" onClick={onClose}>Close camera</Button>
    </div>
  );
}
