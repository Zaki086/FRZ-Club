"use client";
// What this club can really do right now (completion pass §1). Screens render only enabled options — a payment
// method, delivery or email that isn't set up is simply absent, never shown and then rejected.
import { useEffect, useState } from "react";
import { api } from "./api";

export type CounterMethod = "CASH" | "CARD" | "UPI";
export type PublicCapabilities = {
  counterMethods: CounterMethod[];
  online: boolean;
  email: boolean;
  delivery: { fee: number; pincodes: string[] } | null;
  gst: boolean;
  upiVpa: string | null;
  clubName: string;
  sampleData: boolean;
};

export const METHOD_LABEL: Record<string, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI", BANK_TRANSFER: "Bank transfer", ONLINE: "Online" };

let cached: { at: number; value: PublicCapabilities } | null = null;
let inflight: Promise<PublicCapabilities> | null = null;

export function loadCapabilities(force = false): Promise<PublicCapabilities> {
  if (!force && cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.value);
  inflight ??= api<PublicCapabilities>("/api/capabilities")
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The club's public capabilities; null while loading. */
export function useCapabilities(): PublicCapabilities | null {
  const [caps, setCaps] = useState<PublicCapabilities | null>(cached?.value ?? null);
  useEffect(() => {
    let alive = true;
    loadCapabilities()
      .then((c) => alive && setCaps(c))
      .catch(() => alive && setCaps({ counterMethods: ["CASH"], online: false, email: false, delivery: null, gst: false, upiVpa: null, clubName: "", sampleData: false }));
    return () => {
      alive = false;
    };
  }, []);
  return caps;
}
