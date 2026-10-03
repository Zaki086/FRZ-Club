"use client";
// Client-side API helper. The UI never computes business numbers — it renders what these calls return,
// and shows server rejection messages verbatim (plan §2).
import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(code: string, message: string, status: number, details: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export async function api<T = unknown>(
  url: string,
  opts: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("NETWORK", "Could not reach the server. Check the connection and try again.", 0, null);
  }
  let json: { data?: T; error?: { code: string; message: string; details: unknown } } = {};
  try {
    json = await res.json();
  } catch {
    throw new ApiError("BAD_RESPONSE", `The server returned an unexpected response (${res.status}).`, res.status, null);
  }
  if (!res.ok || json.error) {
    const e = json.error ?? { code: "HTTP_" + res.status, message: `Request failed (${res.status}).`, details: null };
    throw new ApiError(e.code, e.message, res.status, e.details);
  }
  return json.data as T;
}

/** GET with loading/error state and optional polling (≤ 10 s courts, ≤ 5 s KDS). */
export function useApi<T>(url: string | null, opts: { pollMs?: number } = {}) {
  const [state, setState] = useState<{ url: string | null; data?: T; error: ApiError | null }>({ url, error: null });
  const [tick, setTick] = useState(0);
  const pollMs = opts.pollMs;

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const run = async () => {
      try {
        const d = await api<T>(url);
        if (!cancelled) setState({ url, data: d, error: null });
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof ApiError ? e : new ApiError("CLIENT", String(e), 0, null);
        setState((s) => ({ url, data: s.url === url ? s.data : undefined, error: err }));
      }
    };
    void run();
    const t = pollMs ? setInterval(run, pollMs) : undefined;
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
  }, [url, pollMs, tick]);

  const current = state.url === url ? state : { url, data: undefined, error: null };
  const reload = useCallback(async () => setTick((t) => t + 1), []);
  const setData = useCallback((d: T) => setState({ url, data: d, error: null }), [url]);
  return {
    data: current.data,
    error: current.error,
    loading: !!url && current.data === undefined && !current.error,
    reload,
    setData,
  };
}
