// v6 URL-4: repair links baked into stored, still-pending message text from an old APP_URL (a Cloudflare quick tunnel
// `*.trycloudflare.com`, an `http(s)://<ip>:<port>` address, localhost, or another address of this club such as the
// plain-http or nip.io twin of the public name). Each such origin is replaced with the current APP_URL origin; the
// path, query and fragment are kept. Dry-run by default (read-only SELECTs); `apply` rewrites each row in its own
// transaction with one audit row per changed row. Links to other sites (wa.me, maps, a logo CDN) are never touched.
// Saved message templates are only reported (their text is edited by staff in Settings → Messages).
import { publicOrigin } from "@/lib/url";
import { prisma, withTx, type Tx } from "../db";
import type { Actor } from "../rbac/actor";
import { audit } from "./audit";

/** One text column of a table that holds message text, and which rows of it are still waiting to go out. */
type Target = { table: string; columns: string[]; json?: string[]; pending: string; reportOnly?: boolean };

/** Where pending message text lives (checked against prisma/schema.prisma). */
export const REPAIR_TARGETS: Target[] = [
  {
    table: "notification_deliveries",
    columns: ["title", "body", "link", "whatsapp_text"],
    json: ["wa_params"],
    // Waiting to be sent (by the worker or by hand); EXPIRED manual tasks can still be sent individually (SA-3).
    pending: "status IN ('QUEUED', 'LINK_OPENED', 'EXPIRED')",
  },
  { table: "email_outbox", columns: ["subject", "body"], pending: "sent_at IS NULL AND error IS NULL" },
  { table: "notifications", columns: ["body", "link"], pending: "read_at IS NULL" },
  { table: "message_bulk_sends", columns: [], json: ["overrides"], pending: "status IN ('QUEUED', 'SENDING')" },
  {
    table: "message_templates",
    columns: ["whatsapp_text", "email_subject", "email_body", "push_title", "push_body"],
    pending: "archived_at IS NULL",
    reportOnly: true,
  },
];

const ORIGIN_RE = /\bhttps?:\/\/[^\s/?#"'<>()[\]{}\\|^`]+/gi;

function hostOf(origin: string): { hostname: string; origin: string } | null {
  try {
    const u = new URL(origin);
    return { hostname: u.hostname.toLowerCase().replace(/^\[|\]$/g, ""), origin: u.origin };
  } catch {
    return null;
  }
}

/**
 * Whether `origin` is an old address of this club that must become APP_URL: a quick tunnel, localhost, a bare IP,
 * the public name on another scheme/port, an sslip.io/nip.io name (they only ever point at our server), or one of
 * `extra`. The APP_URL origin itself and every other site are left alone.
 */
export function isOldClubOrigin(origin: string, appOrigin: string, extra: string[] = []): boolean {
  const o = hostOf(origin);
  if (!o) return false;
  const app = hostOf(appOrigin);
  if (app && o.origin === app.origin) return false;
  const h = o.hostname;
  if (h === "trycloudflare.com" || h.endsWith(".trycloudflare.com")) return true;
  if (h === "localhost" || h.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return true;
  if (app && h === app.hostname) return true;
  if (h.endsWith(".sslip.io") || h.endsWith(".nip.io")) return true;
  return extra.some((e) => hostOf(e)?.origin === o.origin);
}

/** The text with every old club origin replaced by `appOrigin`, and the old origins found. */
export function repairText(text: string, appOrigin: string, extra: string[] = []): { text: string; found: string[] } {
  const found: string[] = [];
  const out = text.replace(ORIGIN_RE, (match) => {
    const m = match.replace(/[.,;:!]+$/, ""); // sentence punctuation right after a bare origin
    const tail = match.slice(m.length);
    const o = hostOf(m)?.origin ?? m;
    if (!isOldClubOrigin(o, appOrigin, extra)) return match;
    found.push(o);
    return appOrigin + tail;
  });
  return { text: out, found };
}

export type RepairRow = { table: string; column: string; oldOrigin: string; rows: number; links: number };
export type RepairReport = {
  appOrigin: string;
  applied: boolean;
  /** Rows changed (or that would change) per table. */
  rowsByTable: Record<string, number>;
  /** Per table / column / old origin: rows and link occurrences. */
  details: RepairRow[];
  /** Saved templates that contain an old origin (not changed by this script). */
  templates: RepairRow[];
};

type Change = { id: string; before: Record<string, unknown>; after: Record<string, unknown> };

type RepairOpts = { apply?: boolean; appOrigin?: string; extraOrigins?: string[]; actor?: Actor };

/** URL-4: find (and with `apply`, fix) old club origins in pending message rows. A dry run reads inside a READ ONLY
 *  transaction, so it is safe against the live club's database. */
export async function repairMessageLinks(opts: RepairOpts = {}): Promise<RepairReport> {
  if (opts.apply) return run(prisma, opts);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return run(tx, opts);
  }, { timeout: 300_000, maxWait: 60_000 });
}

async function run(db: Pick<Tx, "$queryRawUnsafe">, opts: RepairOpts): Promise<RepairReport> {
  const appOrigin = opts.appOrigin ?? publicOrigin();
  if (!appOrigin) throw new Error("APP_URL is not set: there is no address to repair the links to.");
  const extra = opts.extraOrigins ?? [];
  const actor: Actor = opts.actor ?? { kind: "SYSTEM", name: "messages-repair-links" };
  const report: RepairReport = { appOrigin, applied: !!opts.apply, rowsByTable: {}, details: [], templates: [] };
  const tally = new Map<string, RepairRow>();
  const count = (bucket: "details" | "templates", table: string, column: string, found: string[]) => {
    const seen = new Set<string>();
    for (const o of found) {
      const key = `${bucket}|${table}|${column}|${o}`;
      let r = tally.get(key);
      if (!r) {
        r = { table, column, oldOrigin: o, rows: 0, links: 0 };
        tally.set(key, r);
        report[bucket].push(r);
      }
      r.links++;
      if (!seen.has(o)) r.rows++;
      seen.add(o);
    }
  };

  for (const t of REPAIR_TARGETS) {
    const json = t.json ?? [];
    const cols = [...t.columns, ...json];
    const exists = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`, t.table);
    if (!exists[0]?.n) continue;
    const anyHas = cols.map((c) => `${json.includes(c) ? `${c}::text` : c} ~* 'https?://'`).join(" OR ");
    const select = cols.map((c) => (json.includes(c) ? `${c}::text AS "${c}"` : `"${c}"`)).join(", ");
    const rows = await db.$queryRawUnsafe<Record<string, string | null>[]>(`SELECT id, ${select} FROM ${t.table} WHERE (${t.pending}) AND (${anyHas}) ORDER BY id`);
    const changes: Change[] = [];
    for (const row of rows) {
      const change: Change = { id: String(row.id), before: {}, after: {} };
      for (const c of cols) {
        const v = row[c];
        if (typeof v !== "string" || !v) continue;
        const r = repairText(v, appOrigin, extra);
        if (!r.found.length) continue;
        count(t.reportOnly ? "templates" : "details", t.table, c, r.found);
        change.before[c] = json.includes(c) ? JSON.parse(v) : v;
        change.after[c] = json.includes(c) ? JSON.parse(r.text) : r.text;
      }
      if (Object.keys(change.after).length) changes.push(change);
    }
    if (t.reportOnly) continue;
    report.rowsByTable[t.table] = changes.length;
    if (!opts.apply) continue;
    for (const ch of changes) {
      await withTx(async (tx) => {
        const keys = Object.keys(ch.after);
        const sets = keys.map((k, i) => (json.includes(k) ? `"${k}" = $${i + 2}::jsonb` : `"${k}" = $${i + 2}`)).join(", ");
        const values = keys.map((k) => (json.includes(k) ? JSON.stringify(ch.after[k]) : ch.after[k]));
        await tx.$executeRawUnsafe(`UPDATE ${t.table} SET ${sets}, updated_at = now() WHERE id = $1`, ch.id, ...values);
        await audit(tx, actor, "message.links_repaired", t.table, ch.id, { before: ch.before, after: ch.after, reason: `URL-4: old address replaced with ${appOrigin}` });
      });
    }
  }
  return report;
}

/** The report as plain text (for the script's output and PROGRESS.md). */
export function formatRepairReport(r: RepairReport): string {
  const lines = [
    `messages:repair-links — ${r.applied ? "APPLIED" : "dry run (nothing written; pass --apply to write)"}`,
    `New origin: ${r.appOrigin}`,
    "",
    "Rows with old links (pending messages):",
    ...Object.entries(r.rowsByTable).map(([t, n]) => `  ${t}: ${n}`),
    "",
    "By table / column / old origin (rows, links):",
    ...(r.details.length ? r.details.map((d) => `  ${d.table}.${d.column}  ${d.oldOrigin}  rows=${d.rows} links=${d.links}`) : ["  none"]),
  ];
  if (r.templates.length) {
    lines.push("", "Saved templates with an old address (not changed — edit them in Settings → Messages):");
    lines.push(...r.templates.map((d) => `  ${d.table}.${d.column}  ${d.oldOrigin}  rows=${d.rows} links=${d.links}`));
  }
  return lines.join("\n");
}
