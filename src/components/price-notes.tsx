"use client";
// v3 PR-14: current time bands, special dates and promotions from the price book (e.g. "Peak pricing 18:00–21:00"),
// shown where people see prices. Nothing is shown when there are none.
import { useApi } from "./api";

type Note = { id: string; kind: string; scope: string; text: string };

export function PriceNotes({ scopes, title = "Pricing right now" }: { scopes: Array<"COURTS" | "SOCIAL" | "PRODUCTS" | "MENU">; title?: string }) {
  const state = useApi<Note[]>("/api/pricing/public");
  const notes = (state.data ?? []).filter((n) => scopes.includes(n.scope as never));
  if (!notes.length) return null;
  return (
    <aside className="rounded-2xl border border-accent/60 bg-accent/15 p-3 text-sm" data-testid="price-notes">
      <p className="eyebrow mb-1">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {notes.map((n) => <li key={n.id}>{n.text}</li>)}
      </ul>
    </aside>
  );
}
