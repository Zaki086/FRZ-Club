"use client";
import { useEffect } from "react";

/** Opens the print dialog once the receipt is on screen; the button is for reprints. */
export function PrintNow() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <button type="button" className="no-print mt-3 w-full rounded border border-black py-1 text-[12px]" onClick={() => window.print()}>
      Print again
    </button>
  );
}
