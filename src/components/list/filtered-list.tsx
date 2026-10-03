"use client";
// v3 §3: the standard FilterBar + summary strip + dense table every list uses.
// Search (300 ms), date presets (IST) with a day stepper, multi-select facets with counts, sort, page size,
// removable chips, "Clear all", "N results", CSV export, saved views — all in the URL.
import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Search, X } from "lucide-react";
import { api, ApiError, useApi } from "../api";
import { DataState, Empty, RejectionBanner } from "../states";
import { Button } from "../ui/button";
import { Input, Select } from "../ui/input";
import { Table, TBody, TD, TH, THead, TR } from "../ui/table";
import { cn } from "../ui/cn";
import { formatINR } from "@/lib/money";
import { hmm } from "@/lib/duration";
import { addDays, fmtDay } from "@/lib/time";
import { useList, type ListData } from "./use-list";

const PRESETS: Array<[string, string]> = [["TODAY", "Today"], ["YESTERDAY", "Yesterday"], ["THIS_WEEK", "This week"], ["LAST_7", "Last 7 days"], ["THIS_MONTH", "This month"], ["LAST_MONTH", "Last month"], ["CUSTOM", "Custom…"]];

const ReloadContext = createContext<() => void>(() => {});
/** For actions inside a row (e.g. a correction dialog): reload the list after a change. */
export const useListReload = () => useContext(ReloadContext);

export type Column<R> = { key: string; header: ReactNode; className?: string; cell: (r: R) => ReactNode };

function SummaryStrip<R>({ data, update }: { data: ListData<R>; update: (p: Record<string, string | null>) => void }) {
  if (!data.summary.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="summary-strip">
      {data.summary.map((s) => {
        const value = <span className="font-display text-2xl font-bold tabular">{s.format === "money" ? formatINR(s.value) : s.format === "minutes" ? hmm(s.value) : s.value.toLocaleString("en-IN")}</span>;
        const label = <span className="text-xs font-semibold text-muted-foreground">{s.label}</span>;
        // A total of the current filter (nothing narrower to show) is a plain figure, not a button.
        if (!Object.keys(s.apply).length) return <div key={s.key} className="flex flex-col items-start rounded-2xl border bg-card p-3 shadow-soft">{label}{value}</div>;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => update(s.apply)}
            className="flex flex-col items-start rounded-2xl border bg-card p-3 text-left shadow-soft transition hover:-translate-y-px hover:border-primary"
            title={`Show: ${s.label}`}
          >
            {label}{value}
          </button>
        );
      })}
    </div>
  );
}

function FacetMenu({ facet, selected, onChange }: { facet: ListData<unknown>["facets"][number]; selected: string[]; onChange: (v: string[]) => void }) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button
          type="button"
          className={cn("inline-flex h-9 items-center gap-1 rounded-full border px-3 text-sm font-semibold", selected.length ? "border-primary bg-primary/10 text-primary" : "border-input bg-card hover:bg-secondary")}
          aria-label={`Filter by ${facet.label}`}
        >
          {facet.label}
          {selected.length ? <span className="rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">{selected.length}</span> : null}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="start" sideOffset={6} className="z-50 max-h-80 min-w-56 overflow-y-auto rounded-2xl border bg-popover p-1.5 shadow-lift">
          {facet.options.length === 0 ? <p className="px-2 py-1.5 text-sm text-muted-foreground">No values</p> : null}
          {facet.options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <Menu.CheckboxItem
                key={o.value}
                checked={on}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-secondary"
              >
                <span className={cn("grid h-4 w-4 place-items-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>{on ? <Check className="h-3 w-3" /> : null}</span>
                <span className="flex-1">{o.label}</span>
                <span className="tabular text-xs text-muted-foreground">{o.count}</span>
              </Menu.CheckboxItem>
            );
          })}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function SavedViews({ list, qs, onPick }: { list: string; qs: string; onPick: (q: string) => void }) {
  const views = useApi<Array<{ id: string; name: string; query: string }>>(`/api/views?list=${list}`);
  const [name, setName] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" className="inline-flex h-9 items-center gap-1 rounded-full border border-input bg-card px-3 text-sm font-semibold hover:bg-secondary" aria-label="Saved views">
          <Bookmark className="h-3.5 w-3.5" /> Views
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className="z-50 w-72 rounded-2xl border bg-popover p-2 shadow-lift">
          {(views.data ?? []).map((v) => (
            <div key={v.id} className="flex items-center gap-1">
              <Menu.Item onSelect={() => onPick(v.query)} className="flex-1 cursor-pointer rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-secondary">{v.name}</Menu.Item>
              <button type="button" className="rounded-full p-1 hover:bg-secondary" aria-label={`Delete view ${v.name}`} onClick={async () => { await api(`/api/views/${v.id}`, { method: "DELETE" }); await views.reload(); }}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {views.data && views.data.length === 0 ? <p className="px-2 pb-1 text-xs text-muted-foreground">No saved views yet.</p> : null}
          <form
            className="mt-2 flex gap-1 border-t pt-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await api("/api/views", { body: { list, name, query: qs } });
                setName("");
                await views.reload();
              } catch (err) {
                setError(err instanceof ApiError ? { code: err.code, message: err.message } : { message: String(err) });
              }
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Input className="h-8" placeholder="Save this view as…" value={name} onChange={(e) => setName(e.target.value)} aria-label="View name" />
            <Button type="submit" size="sm" disabled={!name.trim()}>Save</Button>
          </form>
          <RejectionBanner error={error} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function FilterBar<R>({ data, params, update, replaceAll, qs, list, searchPlaceholder, dayStepper }: {
  data: ListData<R>;
  params: Record<string, string>;
  update: (p: Record<string, string | null>) => void;
  replaceAll: (q: string) => void;
  qs: string;
  list: string;
  searchPlaceholder: string;
  dayStepper?: boolean;
}) {
  const [q, setQ] = useState(params.q ?? "");
  // A chip or saved view changed the search: show it in the box.
  const [urlQ, setUrlQ] = useState(params.q ?? "");
  if ((params.q ?? "") !== urlQ) {
    setUrlQ(params.q ?? "");
    setQ(params.q ?? "");
  }
  useEffect(() => {
    if ((params.q ?? "") === q) return;
    const t = setTimeout(() => update({ q: q.trim() || null }), 300);
    return () => clearTimeout(t);
  }, [q, params.q, update]);
  const range = params.range ?? "";
  // Step from the day in the address bar, not the last response, so quick repeated clicks all count.
  const singleDay =
    range === "CUSTOM" && params.from && params.from === params.to ? params.from : data.range.from && data.range.from === data.range.to ? data.range.from : null;
  const chips: Array<{ label: string; clear: Record<string, string | null> }> = [];
  if (params.q) chips.push({ label: `“${params.q}”`, clear: { q: null } });
  if (range) chips.push({ label: `${data.dateLabel ?? "Date"}: ${range === "CUSTOM" ? `${data.range.from ?? "…"} → ${data.range.to ?? "…"}` : PRESETS.find((p) => p[0] === range)?.[1] ?? range}`, clear: { range: null, from: null, to: null } });
  for (const f of data.facets) {
    const sel = params[f.key]?.split(",").filter(Boolean) ?? [];
    for (const v of sel) chips.push({ label: `${f.label}: ${f.options.find((o) => o.value === v)?.label ?? v}`, clear: { [f.key]: sel.filter((x) => x !== v).join(",") || null } });
  }
  return (
    <div className="flex flex-col gap-2" data-testid="filter-bar">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-9 rounded-full pl-9" placeholder={searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </label>
        {data.dateLabel ? (
          <div className="flex items-center gap-1">
            {dayStepper && singleDay ? (
              <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Previous day" onClick={() => update({ range: "CUSTOM", from: addDays(singleDay, -1), to: addDays(singleDay, -1) })}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
            ) : null}
            <Select className="h-9 w-40 rounded-full" value={range} onChange={(e) => update(e.target.value === "CUSTOM" ? { range: "CUSTOM", from: data.range.from, to: data.range.to } : { range: e.target.value || null, from: null, to: null })} aria-label={data.dateLabel}>
              <option value="">Any {data.dateLabel.toLowerCase()}</option>
              {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            {dayStepper && singleDay ? (
              <Button variant="outline" size="icon" className="h-9 w-9" aria-label="Next day" onClick={() => update({ range: "CUSTOM", from: addDays(singleDay, 1), to: addDays(singleDay, 1) })}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : null}
            {singleDay ? <span className="hidden text-sm font-semibold sm:inline">{fmtDay(singleDay)}</span> : null}
          </div>
        ) : null}
        {range === "CUSTOM" ? (
          <span className="flex items-center gap-1">
            <Input type="date" className="h-9 w-40" value={params.from ?? ""} onChange={(e) => update({ from: e.target.value || null })} aria-label="From" />
            <span className="text-muted-foreground">→</span>
            <Input type="date" className="h-9 w-40" value={params.to ?? ""} onChange={(e) => update({ to: e.target.value || null })} aria-label="To" />
          </span>
        ) : null}
        {data.facets.map((f) => (
          <FacetMenu key={f.key} facet={f as ListData<unknown>["facets"][number]} selected={params[f.key]?.split(",").filter(Boolean) ?? []} onChange={(v) => update({ [f.key]: v.join(",") || null })} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold" data-testid="result-count">{data.total.toLocaleString("en-IN")} result{data.total === 1 ? "" : "s"}</span>
        {chips.map((c) => (
          <button key={c.label} type="button" onClick={() => update(c.clear)} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground hover:bg-secondary/70" aria-label={`Remove filter ${c.label}`}>
            {c.label} <X className="h-3 w-3" />
          </button>
        ))}
        {chips.length ? <button type="button" className="text-xs font-semibold text-primary underline" onClick={() => replaceAll(`sort=${data.query.sort}`)}>Clear all</button> : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Select className="h-8 w-40 rounded-full text-xs" value={data.query.sort} onChange={(e) => update({ sort: e.target.value })} aria-label="Sort">
            {data.sorts.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
          <Select className="h-8 w-24 rounded-full text-xs" value={String(data.size)} onChange={(e) => update({ size: e.target.value === "25" ? null : e.target.value })} aria-label="Page size">
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </Select>
          <SavedViews list={list} qs={qs} onPick={replaceAll} />
          {data.canExport ? (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/lists/${list}/csv?${qs}`} download><Download className="h-3.5 w-3.5" /> CSV</a>
            </Button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function Pager<R>({ data, update }: { data: ListData<R>; update: (p: Record<string, string | null>) => void }) {
  if (data.pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-sm">
      <Button variant="outline" size="sm" disabled={data.page <= 1} onClick={() => update({ page: String(data.page - 1) })}>Previous</Button>
      <span className="tabular">Page {data.page} of {data.pages}</span>
      <Button variant="outline" size="sm" disabled={data.page >= data.pages} onClick={() => update({ page: String(data.page + 1) })}>Next</Button>
    </div>
  );
}

/** A list page body: summary strip, FilterBar, then a dense table (or a custom view of the rows), then paging. */
export function FilteredList<R extends { id: string }>({ list, columns, searchPlaceholder, onRowClick, rowExtra, toolbar, pollMs, dayStepper, view, empty }: {
  list: string;
  columns: Column<R>[];
  searchPlaceholder: string;
  onRowClick?: (r: R) => void;
  /** Expanded detail under a row (row expand instead of navigating away). */
  rowExtra?: (r: R) => ReactNode;
  toolbar?: ReactNode;
  pollMs?: number;
  dayStepper?: boolean;
  /** Replace the table with another presentation of the same rows (e.g. a board). */
  view?: (rows: R[], data: ListData<R>) => ReactNode;
  empty?: { title: string; hint?: string };
}) {
  const s = useList<R>(list, { pollMs });
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <ReloadContext.Provider value={s.reload}>
    <DataState state={s}>
      {(data) => (
        <div className="flex flex-col gap-3">
          {toolbar ? <div className="flex flex-wrap justify-end gap-2">{toolbar}</div> : null}
          <SummaryStrip data={data} update={s.update} />
          <FilterBar data={data} params={s.params} update={s.update} replaceAll={s.replaceAll} qs={s.qs} list={list} searchPlaceholder={searchPlaceholder} dayStepper={dayStepper} />
          {data.rows.length === 0 ? (
            <Empty title={empty?.title ?? "Nothing matches these filters"} hint={empty?.hint ?? "Remove a filter or widen the dates."} />
          ) : view ? (
            view(data.rows, data)
          ) : (
            <Table>
              <THead>
                <TR>{columns.map((c) => <TH key={c.key} className={c.className}>{c.header}</TH>)}</TR>
              </THead>
              <TBody>
                {data.rows.map((r) => (
                  <Fragment key={r.id}>
                    <TR
                      className={cn(onRowClick || rowExtra ? "cursor-pointer" : "", expanded === r.id && "bg-secondary/50")}
                      onClick={() => (onRowClick ? onRowClick(r) : rowExtra ? setExpanded(expanded === r.id ? null : r.id) : undefined)}
                    >
                      {columns.map((c) => <TD key={c.key} className={c.className}>{c.cell(r)}</TD>)}
                    </TR>
                    {rowExtra && expanded === r.id ? (
                      <tr className="bg-secondary/30">
                        <td colSpan={columns.length} className="px-4 py-3">{rowExtra(r)}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </TBody>
            </Table>
          )}
          <Pager data={data} update={s.update} />
        </div>
      )}
    </DataState>
    </ReloadContext.Provider>
  );
}
