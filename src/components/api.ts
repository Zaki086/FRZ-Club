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

/**
 * A random key per user action. `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost), so on
 * plain HTTP (e.g. http://<server-ip>:3200) we build a v4 UUID from `crypto.getRandomValues`, which is always available.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const SESSION_ENDED_EVENT = "cc:session-ended";
/** Fired after logging in again from the SessionGuard: every open useApi fetches again. */
export const SESSION_RESTORED_EVENT = "cc:session-restored";
const LOGIN_URL = "/api/auth/login";

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
    // v3 §6.1: a session that ended mid-use opens the "log in again" dialog (SessionGuard) instead of a dead page.
    if (res.status === 401 && e.code === "UNAUTHENTICATED" && url !== LOGIN_URL && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT));
    }
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

  useEffect(() => {
    const again = () => setTick((t) => t + 1);
    window.addEventListener(SESSION_RESTORED_EVENT, again);
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, again);
  }, []);

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
