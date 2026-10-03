"use client";
// Completion pass §4: a sample-data instance says so on every page, so nobody mistakes it for a real club.
import { useCapabilities } from "./capabilities";

export function SampleDataBanner() {
  const caps = useCapabilities();
  if (!caps?.sampleData) return null;
  return (
    <div role="status" className="no-print bg-amber-400 px-3 py-1 text-center text-xs font-semibold text-amber-950" data-testid="sample-data-banner">
      Sample data — a demonstration club. Every name, number and transaction here is fictitious.
    </div>
  );
}
