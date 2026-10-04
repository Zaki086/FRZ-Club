import type { ReactNode } from "react";

/**
 * Compact page header (v6 UI-1, UI-3): the title (~24–28 px, not a display heading) and the primary actions on one
 * line; the page's summary strip follows directly below. Pages carry no description sentence (UI-1): `meta` is only
 * for a short line of the record's own data (role · phone · joined, code · customer), never explanatory prose.
 */
export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  /** @deprecated v6 UI-1 — page descriptions are gone; this prop is ignored and no page may pass it. */
  subtitle?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 [.flex-col>&]:mb-0" data-page-header>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold leading-tight sm:text-[1.75rem]">{title}</h1>
        {meta ? <div className="mt-0.5 text-sm text-muted-foreground">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
