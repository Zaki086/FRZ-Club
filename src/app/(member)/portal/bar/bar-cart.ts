"use client";
// v5 §1.2 (ORDER): the Bar & Café cart, kept in this browser per member (a guardian's cart for a Junior is separate).
// Only item ids, quantities, notes and display names live here — the server prices every order again (MO-6).
// Storage can be unavailable (private mode), so every access is guarded and an in-memory copy keeps working.
import { useCallback, useSyncExternalStore } from "react";

export type BarCartLine = { menuItemId: string; name: string; qty: number; note: string };

const PREFIX = "cc_bar_cart_v1:";
const EVENT = "cc-bar-cart-change";
const MAX_QTY = 20;
const cache = new Map<string, { raw: string | null; lines: BarCartLine[] }>();
const memory = new Map<string, BarCartLine[]>();
const EMPTY: BarCartLine[] = [];

function read(memberId: string): BarCartLine[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PREFIX + memberId);
  } catch {
    return memory.get(memberId) ?? EMPTY;
  }
  const hit = cache.get(memberId);
  if (hit && hit.raw === raw) return hit.lines;
  let lines: BarCartLine[] = [];
  try {
    const parsed = raw ? (JSON.parse(raw) as BarCartLine[]) : [];
    lines = Array.isArray(parsed)
      ? parsed.filter((l) => l && typeof l.menuItemId === "string" && Number.isInteger(l.qty) && l.qty > 0).map((l) => ({ ...l, note: typeof l.note === "string" ? l.note : "" }))
      : [];
  } catch {
    lines = [];
  }
  cache.set(memberId, { raw, lines });
  return lines;
}

function write(memberId: string, lines: BarCartLine[]) {
  memory.set(memberId, lines);
  try {
    window.localStorage.setItem(PREFIX + memberId, JSON.stringify(lines));
  } catch {
    // storage unavailable — the in-memory cart still works for this page view
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useBarCart(memberId: string | null) {
  const lines = useSyncExternalStore(subscribe, () => (memberId ? read(memberId) : EMPTY), () => EMPTY);
  const add = useCallback((item: { id: string; name: string }) => {
    if (!memberId) return;
    const cur = read(memberId);
    const i = cur.findIndex((l) => l.menuItemId === item.id && !l.note);
    write(memberId, i >= 0 ? cur.map((l, j) => (j === i ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l)) : [...cur, { menuItemId: item.id, name: item.name, qty: 1, note: "" }]);
  }, [memberId]);
  const setQty = useCallback((index: number, qty: number) => {
    if (!memberId) return;
    const cur = read(memberId);
    write(memberId, qty <= 0 ? cur.filter((_, j) => j !== index) : cur.map((l, j) => (j === index ? { ...l, qty: Math.min(MAX_QTY, qty) } : l)));
  }, [memberId]);
  const setNote = useCallback((index: number, note: string) => {
    if (!memberId) return;
    write(memberId, read(memberId).map((l, j) => (j === index ? { ...l, note: note.slice(0, 120) } : l)));
  }, [memberId]);
  /** Drop lines whose item left the menu (sold out, archived, or hidden for this member). */
  const keepOnly = useCallback((ids: Set<string>) => {
    if (!memberId) return;
    const cur = read(memberId);
    if (cur.some((l) => !ids.has(l.menuItemId))) write(memberId, cur.filter((l) => ids.has(l.menuItemId)));
  }, [memberId]);
  const clear = useCallback(() => {
    if (memberId) write(memberId, []);
  }, [memberId]);
  return { lines, add, setQty, setNote, keepOnly, clear };
}
