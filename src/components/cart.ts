"use client";
// Browser cart for the public shop. Only variant ids, quantities and display names are kept here —
// prices always come from the server quote. Storage can be unavailable (private mode), so every access is guarded.
import { useSyncExternalStore } from "react";

export type CartLine = { variantId: string; qty: number; name: string };

const KEY = "cc_cart_v1";
const EVENT = "cc-cart-change";
let cachedRaw: string | null = null;
let cached: CartLine[] = [];
let memory: CartLine[] = [];

function read(): CartLine[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return memory;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as CartLine[]) : [];
    cached = Array.isArray(parsed) ? parsed.filter((l) => l && typeof l.variantId === "string" && l.qty > 0) : [];
  } catch {
    cached = [];
  }
  return cached;
}

function write(lines: CartLine[]) {
  memory = lines;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(lines));
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

const EMPTY: CartLine[] = [];

export function useCart(): CartLine[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function addToCart(line: { variantId: string; name: string }, qty = 1) {
  const lines = read();
  const ex = lines.find((l) => l.variantId === line.variantId);
  write(ex ? lines.map((l) => (l.variantId === line.variantId ? { ...l, qty: Math.min(50, l.qty + qty) } : l)) : [...lines, { ...line, qty }]);
}

export function setCartQty(variantId: string, qty: number) {
  const lines = read();
  write(qty <= 0 ? lines.filter((l) => l.variantId !== variantId) : lines.map((l) => (l.variantId === variantId ? { ...l, qty: Math.min(50, qty) } : l)));
}

export function clearCart() {
  write([]);
}
