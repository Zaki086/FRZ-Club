"use client";
import { useEffect, useState } from "react";

/** Wall-clock "now" for display only (hiding actions that the server would refuse anyway). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
