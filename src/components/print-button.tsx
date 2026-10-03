"use client";
import { Printer } from "lucide-react";
import { Button } from "./ui/button";

/** Print the page (the browser's "Save as PDF" downloads it). */
export function PrintButton({ label = "Print / Save as PDF" }: { label?: string }) {
  return (
    <Button variant="outline" onClick={() => window.print()}>
      <Printer className="h-4 w-4" /> {label}
    </Button>
  );
}
