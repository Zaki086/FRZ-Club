"use client";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

/**
 * Empty state (v6 UI-4): one short line and at most one action. `hint` is kept so older call sites type-check, but it
 * is no longer shown — no explanatory sentence under an empty list.
 */
export function Empty({ title, action }: { title: string; /** @deprecated v6 UI-4 — ignored */ hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-card px-4 py-6 text-center" data-empty-state>
      <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-semibold">{title}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 py-8 text-center">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="max-w-md text-sm text-destructive">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Wraps a useApi result: loading → error → empty → content. */
export function DataState<T>({
  state,
  empty,
  isEmpty,
  children,
}: {
  state: { data: T | undefined; error: { message: string } | null; loading: boolean; reload: () => void };
  empty?: { title: string; hint?: string; action?: ReactNode };
  isEmpty?: (d: T) => boolean;
  children: (d: T) => ReactNode;
}) {
  if (state.error && state.data === undefined) return <ErrorState message={state.error.message} onRetry={state.reload} />;
  if (state.data === undefined) return <Loading />;
  if (empty && isEmpty?.(state.data)) return <Empty {...empty} />;
  return <>{children(state.data)}</>;
}

export function RejectionBanner({ error }: { error: { code?: string; message: string } | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {error.code ? <span className="mr-2 font-mono text-xs font-semibold">{error.code}</span> : null}
      {error.message}
    </div>
  );
}
