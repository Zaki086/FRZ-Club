// v3 §3.1: one list engine behind every FilterBar. A list declares its base rows as SQL, its search fields, its
// date column, its facets (each a SQL expression), sorts and summary numbers; the engine does the rest on the
// server — search, date presets in IST, multi-select facets with a count per option (counted with every *other*
// filter applied), sorting, paging (25/50/100), the summary strip, defaults and CSV. Values are always bound
// parameters; only the expressions written in the list definitions are raw SQL.
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { addDays, addMonths, istDate, istDayRange, isValidDateStr, monthStart, weekStart } from "@/lib/time";
import { prisma, type Tx } from "../../db";
import { DomainError } from "../../errors";
import type { Actor } from "../../rbac/actor";
import { can, type Capability } from "../../rbac/permissions";

export const DATE_PRESETS = ["TODAY", "YESTERDAY", "THIS_WEEK", "LAST_7", "THIS_MONTH", "LAST_MONTH", "CUSTOM"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export const PRESET_LABEL: Record<DatePreset, string> = {
  TODAY: "Today", YESTERDAY: "Yesterday", THIS_WEEK: "This week", LAST_7: "Last 7 days", THIS_MONTH: "This month", LAST_MONTH: "Last month", CUSTOM: "Custom",
};
export const PAGE_SIZES = [25, 50, 100] as const;
const RESERVED = new Set(["q", "range", "from", "to", "sort", "page", "size", "view"]);

export type FacetDef = {
  key: string;
  label: string;
  /** SQL over the base row alias `b`; text (or text[] when `multi`). */
  expr: string;
  multi?: boolean;
  /** Fixed options in display order (labels); otherwise values are taken from the data. */
  options?: Array<{ value: string; label: string }>;
  /** Label lookup for data-driven options: SQL returning (value, label) rows. */
  labelsSql?: string;
  /** Special values: "me" → the signed-in user's id. */
  meAlias?: boolean;
};

export type SummaryDef = { key: string; label: string; sql: string; format: "count" | "money" | "minutes"; apply: Record<string, string> };

export type ListCtx = { actor: Actor; today: string; now: Date; from: string | null; to: string | null; userId: string | null };

export type ListDef = {
  name: string;
  title: string;
  /** Any of these capabilities may view. */
  view: Capability[];
  /** Any of these capabilities may export CSV. */
  exportCaps: Capability[];
  /** Base rows (a SELECT). Must expose every column used below. Date range is applied by the engine on `dateColumn`. */
  base: (ctx: ListCtx) => Prisma.Sql;
  search: string[];
  /** `kind: "base"`: the base SQL applies the range itself (e.g. totals per employee for the period). */
  dateColumn?: { expr: string; label: string; kind: "timestamp" | "date" | "base" };
  facets: FacetDef[];
  sorts: Record<string, { label: string; sql: string }>;
  defaultSort: string;
  summary: SummaryDef[];
  csv: Array<{ key: string; label: string; format?: "money" | "date" | "datetime" }>;
  /** Default query when the list is opened with no parameters. */
  defaults?: (actor: Actor) => Record<string, string>;
  /** Facets the summary strip ignores, so its figures stay the same across tabs built on them (v4 §3.5). */
  summaryIgnores?: string[];
};

export type ListQuery = { q: string; range: DatePreset | null; from: string | null; to: string | null; sort: string; page: number; size: number; facets: Record<string, string[]> };

export function resolveRange(range: DatePreset | null, from: string | null, to: string | null, today: string): { from: string | null; to: string | null } {
  switch (range) {
    case "TODAY": return { from: today, to: today };
    case "YESTERDAY": return { from: addDays(today, -1), to: addDays(today, -1) };
    case "THIS_WEEK": return { from: weekStart(today), to: today };
    case "LAST_7": return { from: addDays(today, -6), to: today };
    case "THIS_MONTH": return { from: monthStart(today), to: today };
    case "LAST_MONTH": {
      const start = monthStart(addMonths(monthStart(today), -1));
      return { from: start, to: addDays(monthStart(today), -1) };
    }
    case "CUSTOM": return { from: from && isValidDateStr(from) ? from : null, to: to && isValidDateStr(to) ? to : null };
    default: return { from: null, to: null };
  }
}

/** Parse URL parameters into a validated query (unknown facet keys and values are rejected, not passed to SQL). */
export function parseQuery(def: ListDef, params: Record<string, string>): ListQuery {
  const base = z.object({
    q: z.string().trim().max(100).default(""),
    range: z.enum(DATE_PRESETS).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    sort: z.string().optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    size: z.coerce.number().int().refine((n) => (PAGE_SIZES as readonly number[]).includes(n), "page size is 25, 50 or 100").default(25),
  }).parse(Object.fromEntries(Object.entries(params).filter(([k]) => RESERVED.has(k))));
  const facets: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(params)) {
    if (RESERVED.has(k) || !v) continue;
    const f = def.facets.find((x) => x.key === k);
    if (!f) throw new DomainError("VALIDATION_FAILED", `Unknown filter "${k}".`);
    const values = v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 50);
    if (values.some((x) => x.length > 80)) throw new DomainError("VALIDATION_FAILED", `Filter "${k}" has a value that is too long.`);
    if (f.options && !f.meAlias && values.some((x) => !f.options!.some((o) => o.value === x))) throw new DomainError("VALIDATION_FAILED", `Filter "${k}" has an unknown value.`);
    facets[k] = values;
  }
  const sort = base.sort && def.sorts[base.sort] ? base.sort : def.defaultSort;
  return { q: base.q, range: base.range ?? null, from: base.from ?? null, to: base.to ?? null, sort, page: base.page, size: base.size, facets };
}

/** The query as URL parameters (normalised), so the client can keep its address bar in step. */
export function toParams(q: ListQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.q) out.q = q.q;
  if (q.range) out.range = q.range;
  if (q.range === "CUSTOM") {
    if (q.from) out.from = q.from;
    if (q.to) out.to = q.to;
  }
  for (const [k, v] of Object.entries(q.facets)) if (v.length) out[k] = v.join(",");
  out.sort = q.sort;
  if (q.page > 1) out.page = String(q.page);
  if (q.size !== 25) out.size = String(q.size);
  return out;
}

function facetCond(f: FacetDef, values: string[], ctx: ListCtx): Prisma.Sql {
  const vals = values.map((v) => (f.meAlias && v === "me" ? (ctx.userId ?? "—") : v));
  return f.multi ? Prisma.sql`(${Prisma.raw(f.expr)}) && ${vals}::text[]` : Prisma.sql`(${Prisma.raw(f.expr)})::text = ANY(${vals}::text[])`;
}

function conditions(def: ListDef, q: ListQuery, ctx: ListCtx, skip?: string | string[]): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (q.q && def.search.length) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    parts.push(Prisma.sql`(${Prisma.join(def.search.map((s) => Prisma.sql`(${Prisma.raw(s)})::text ILIKE ${like}`), " OR ")})`);
  }
  if (def.dateColumn && def.dateColumn.kind !== "base" && (ctx.from || ctx.to)) {
    const col = Prisma.raw(def.dateColumn.expr);
    if (def.dateColumn.kind === "date") {
      if (ctx.from) parts.push(Prisma.sql`${col} >= ${ctx.from}::date`);
      if (ctx.to) parts.push(Prisma.sql`${col} <= ${ctx.to}::date`);
    } else {
      if (ctx.from) parts.push(Prisma.sql`${col} >= ${istDayRange(ctx.from)[0]}`);
      if (ctx.to) parts.push(Prisma.sql`${col} < ${istDayRange(ctx.to)[1]}`);
    }
  }
  for (const f of def.facets) {
    if (Array.isArray(skip) ? skip.includes(f.key) : f.key === skip) continue;
    const v = q.facets[f.key];
    if (v?.length) parts.push(facetCond(f, v, ctx));
  }
  return Prisma.join(parts, " AND ");
}

/**
 * Each list materialises its rows into its own temp table. The name differs per list on purpose: Postgres caches a
 * prepared statement's plan by its text, and two lists whose queries read the same table name with different columns
 * would hit "cached plan must not change result type".
 */
const baseTable = (def: ListDef) => Prisma.raw(`list_base_${def.name.replace(/[^a-z0-9]/gi, "_")}`);

const plain = (v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v);
const plainRow = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)]));

export function assertListAccess(def: ListDef, actor: Actor, exportCsv = false) {
  const caps = exportCsv ? def.exportCaps : def.view;
  if (!caps.some((c) => can(actor, c))) throw new DomainError("FORBIDDEN", exportCsv ? "Not allowed: you cannot export this list." : "Not allowed: you cannot see this list.");
}

function makeCtx(actor: Actor, q: ListQuery): ListCtx {
  const now = clock.now();
  const today = istDate(now);
  const r = resolveRange(q.range, q.from, q.to, today);
  return { actor, today, now, from: r.from, to: r.to, userId: actor.kind === "USER" ? actor.userId : null };
}

/** Run a list: rows for the page, total, facet counts, summary strip, and the normalised query. */
export async function runList(def: ListDef, actor: Actor, params: Record<string, string>) {
  assertListAccess(def, actor);
  const usedDefaults = def.defaults && Object.keys(params).filter((k) => k !== "page" && k !== "size").length === 0;
  const q = parseQuery(def, usedDefaults ? { ...def.defaults!(actor), ...params } : params);
  const ctx = makeCtx(actor, q);
  return prisma.$transaction(async (tx: Tx) => {
    // List SQL reads the business clock through app_now() (time travel and tests use the injectable clock).
    await tx.$executeRaw`SELECT set_config('app.now', ${ctx.now.toISOString()}, true)`;
    await tx.$executeRaw(Prisma.sql`CREATE TEMP TABLE ${baseTable(def)} ON COMMIT DROP AS ${def.base(ctx)}`);
    const where = conditions(def, q, ctx);
    const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM ${baseTable(def)} b WHERE ${where}`);
    const total = Number(n);
    const pages = Math.max(1, Math.ceil(total / q.size));
    const page = Math.min(q.page, pages);
    const rows = await tx.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`SELECT b.* FROM ${baseTable(def)} b WHERE ${where} ORDER BY ${Prisma.raw(def.sorts[q.sort].sql)} LIMIT ${q.size} OFFSET ${(page - 1) * q.size}`,
    );
    const facets = [];
    for (const f of def.facets) {
      const w = conditions(def, q, ctx, f.key);
      const counts = await tx.$queryRaw<{ v: string | null; n: bigint }[]>(
        f.multi
          ? Prisma.sql`SELECT x.v, count(*) AS n FROM ${baseTable(def)} b CROSS JOIN LATERAL unnest(${Prisma.raw(f.expr)}) AS x(v) WHERE ${w} GROUP BY x.v`
          : Prisma.sql`SELECT (${Prisma.raw(f.expr)})::text AS v, count(*) AS n FROM ${baseTable(def)} b WHERE ${w} GROUP BY 1`,
      );
      const labels = f.labelsSql ? new Map((await tx.$queryRaw<{ value: string; label: string }[]>(Prisma.raw(f.labelsSql))).map((r) => [r.value, r.label])) : null;
      const count = (v: string) => Number(counts.find((c) => c.v === v)?.n ?? 0);
      let options = f.options
        ? f.options.map((o) => ({ ...o, count: o.value === "me" ? count(ctx.userId ?? "—") : count(o.value) }))
        : counts.filter((c) => c.v !== null).map((c) => ({ value: c.v!, label: labels?.get(c.v!) ?? c.v!, count: Number(c.n) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      // Keep selected values visible even when nothing matches them now.
      for (const s of q.facets[f.key] ?? []) if (!options.some((o) => o.value === s)) options = [...options, { value: s, label: labels?.get(s) ?? s, count: 0 }];
      facets.push({ key: f.key, label: f.label, options });
    }
    const summaryRow = def.summary.length
      ? (await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${Prisma.join(def.summary.map((s) => Prisma.sql`(${Prisma.raw(s.sql)}) AS ${Prisma.raw(`"${s.key}"`)}`), ", ")} FROM ${baseTable(def)} b WHERE ${def.summaryIgnores?.length ? conditions(def, q, ctx, def.summaryIgnores) : where}`))[0]
      : {};
    return {
      list: def.name,
      title: def.title,
      query: toParams({ ...q, page }),
      range: { preset: q.range, from: ctx.from, to: ctx.to },
      total, page, pages, size: q.size,
      rows: rows.map(plainRow),
      facets,
      summary: def.summary.map((s) => ({ key: s.key, label: s.label, format: s.format, value: Number(plain(summaryRow[s.key]) ?? 0), apply: s.apply })),
      sorts: Object.entries(def.sorts).map(([value, s]) => ({ value, label: s.label })),
      dateLabel: def.dateColumn?.label ?? null,
      canExport: def.exportCaps.some((c) => can(actor, c)),
    };
  }, { timeout: 60_000 });
}

/**
 * v6 SA-5 (SENDALL): the ids of every row matching the list's filter (no paging, no facets), in the list's sort order,
 * capped at `max` — "Send all" applies to exactly what the FilterBar shows.
 */
export async function listMatchingIds(def: ListDef, actor: Actor, params: Record<string, string>, max = 10_000): Promise<string[]> {
  assertListAccess(def, actor);
  const q = parseQuery(def, params);
  const ctx = makeCtx(actor, q);
  return prisma.$transaction(async (tx: Tx) => {
    await tx.$executeRaw`SELECT set_config('app.now', ${ctx.now.toISOString()}, true)`;
    await tx.$executeRaw(Prisma.sql`CREATE TEMP TABLE ${baseTable(def)} ON COMMIT DROP AS ${def.base(ctx)}`);
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT b.id::text AS id FROM ${baseTable(def)} b WHERE ${conditions(def, q, ctx)} ORDER BY ${Prisma.raw(def.sorts[q.sort].sql)} LIMIT ${max}`,
    );
    return rows.map((r) => r.id);
  }, { timeout: 60_000 });
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Every row matching the filter (no paging, capped at 10,000) as CSV. */
export async function listCsv(def: ListDef, actor: Actor, params: Record<string, string>): Promise<string> {
  assertListAccess(def, actor, true);
  const q = parseQuery(def, params);
  const ctx = makeCtx(actor, q);
  const rows = await prisma.$transaction(async (tx: Tx) => {
    await tx.$executeRaw`SELECT set_config('app.now', ${ctx.now.toISOString()}, true)`;
    await tx.$executeRaw(Prisma.sql`CREATE TEMP TABLE ${baseTable(def)} ON COMMIT DROP AS ${def.base(ctx)}`);
    return tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT b.* FROM ${baseTable(def)} b WHERE ${conditions(def, q, ctx)} ORDER BY ${Prisma.raw(def.sorts[q.sort].sql)} LIMIT 10000`);
  }, { timeout: 60_000 });
  const fmt = (v: unknown, f?: string) => {
    const x = plain(v);
    if (x === null || x === undefined) return "";
    if (f === "money") return (Number(x) / 100).toFixed(2);
    if (f === "date") return x instanceof Date ? istDate(x) : String(x).slice(0, 10);
    if (f === "datetime") return x instanceof Date ? `${istDate(x)} ${x.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : String(x);
    return Array.isArray(x) ? x.join(" ") : x;
  };
  return [def.csv.map((c) => c.label), ...rows.map((r) => def.csv.map((c) => fmt(r[c.key], c.format)))].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
