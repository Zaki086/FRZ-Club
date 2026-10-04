// `npm run contacts:normalise [-- --apply]` — v5 §2.2.4 (CV-9): bring existing phones and emails to the canonical
// form of src/lib/validation/contact.ts (mobile/landline → 10 digits; email → trimmed lower-case).
//
// Dry run by default, inside a READ ONLY transaction (safe on the live club). It writes a section for this database
// into contacts-report.md (repo root): what would change, values that are not valid (left as they are), and
// duplicates that normalisation would create in unique columns — nothing is merged or deleted, ever.
// `--apply` writes the changes that don't collide, one audit row each (action contacts.normalise), and creates the
// case-insensitive unique email index (migration 0018) once no clashing emails remain.
// Values in the report are masked (DPDP): records are named by member code / lead code / id.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { normaliseContactPhone, normaliseEmail, normaliseMobile } from "@/lib/validation/contact";

type Kind = "mobile" | "contact" | "email";
type Col = { table: string; column: string; kind: Kind; unique?: boolean; label: string; ref: string };

// Every stored phone/email a person or staff typed. System-received numbers (WhatsApp inbound, delivery logs) are not.
const COLUMNS: Col[] = [
  { table: "members", column: "phone", kind: "mobile", unique: true, label: "Member mobile", ref: "member_code" },
  { table: "members", column: "email", kind: "email", label: "Member email", ref: "member_code" },
  { table: "members", column: "guardian_phone", kind: "mobile", label: "Guardian mobile", ref: "member_code" },
  { table: "members", column: "emergency_contact_phone", kind: "mobile", label: "Emergency contact mobile", ref: "member_code" },
  { table: "users", column: "phone", kind: "mobile", unique: true, label: "Login mobile (users)", ref: "role" },
  { table: "users", column: "email", kind: "email", unique: true, label: "Login email (users)", ref: "role" },
  { table: "guests", column: "phone", kind: "mobile", unique: true, label: "Guest mobile", ref: "NULL" },
  { table: "guests", column: "email", kind: "email", label: "Guest email", ref: "NULL" },
  { table: "leads", column: "phone", kind: "mobile", label: "Lead mobile", ref: "code" },
  { table: "leads", column: "email", kind: "email", label: "Lead email", ref: "code" },
  { table: "business_clients", column: "contact_phone", kind: "contact", label: "Business client phone", ref: "name" },
  { table: "business_clients", column: "contact_email", kind: "email", label: "Business client email", ref: "name" },
];

const NORMALISE: Record<Kind, (s: string) => string | null> = { mobile: normaliseMobile, contact: normaliseContactPhone, email: normaliseEmail };
const REASON: Record<Kind, string> = {
  mobile: "not a valid 10-digit Indian mobile",
  contact: "not a valid Indian mobile or STD landline",
  email: "not a valid email address",
};

type Row = { id: string; ref: string | null; value: string };
type Change = { col: Col; row: Row; next: string };
type Invalid = { col: Col; row: Row; reason: string };
type Dup = { col: Col; value: string; rows: Row[]; createdByNormalisation: boolean };
type Result = {
  db: string;
  counts: Array<{ col: Col; total: number; canonical: number; change: number; invalid: number; erased: number }>;
  changes: Change[];
  invalid: Invalid[];
  dups: Dup[];
  club: { field: "phone" | "email"; value: string; next: string | null }[];
  indexPresent: boolean;
};

const APPLY = process.argv.includes("--apply");
const REPORT = path.resolve(process.cwd(), argValue("--report") ?? "contacts-report.md");

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Masks personal data for the report: keeps the shape, the first 2 and last 2 digits, and an email's domain. */
function mask(kind: Kind, v: string): string {
  if (kind === "email") {
    const at = v.lastIndexOf("@");
    if (at < 0) return v.length <= 2 ? "••" : `${v.slice(0, 1)}•••`;
    return `${v.slice(0, 1)}•••${v.slice(at)}`;
  }
  const total = v.replace(/\D/g, "").length;
  let seen = 0;
  return v.replace(/\d/g, (d) => {
    seen += 1;
    return seen <= 2 || seen > total - 2 ? d : "•";
  });
}

function dbName(url: string | undefined): string {
  try {
    return new URL(url ?? "").pathname.replace(/^\//, "") || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

async function scan(tx: Prisma.TransactionClient, db: string): Promise<Result> {
  const r: Result = { db, counts: [], changes: [], invalid: [], dups: [], club: [], indexPresent: false };
  for (const col of COLUMNS) {
    const rows = await tx.$queryRawUnsafe<Row[]>(
      `SELECT id, ${col.ref}::text AS ref, ${col.column} AS value FROM ${col.table} WHERE ${col.column} IS NOT NULL AND ${col.column} <> '' ORDER BY id`,
    );
    const c = { col, total: rows.length, canonical: 0, change: 0, invalid: 0, erased: 0 };
    const byValue = new Map<string, Row[]>();
    for (const row of rows) {
      // Privacy erasure (DPDP) replaces a phone with "erased-CC-000123" on purpose.
      if (row.value.startsWith("erased-")) {
        c.erased += 1;
        continue;
      }
      const next = NORMALISE[col.kind](row.value);
      if (next === null) {
        c.invalid += 1;
        r.invalid.push({ col, row, reason: REASON[col.kind] });
        continue;
      }
      if (next === row.value) c.canonical += 1;
      else {
        c.change += 1;
        r.changes.push({ col, row, next });
      }
      if (col.unique) byValue.set(next, [...(byValue.get(next) ?? []), row]);
    }
    for (const [value, group] of byValue) {
      if (group.length > 1) r.dups.push({ col, value, rows: group, createdByNormalisation: new Set(group.map((g) => g.value)).size > 1 });
    }
    r.counts.push(c);
  }
  const club = await tx.$queryRawUnsafe<Array<{ value: { phone?: string; email?: string } }>>(`SELECT value FROM settings WHERE key = 'club'`);
  const v = club[0]?.value;
  if (v?.phone?.trim()) r.club.push({ field: "phone", value: v.phone, next: normaliseContactPhone(v.phone) });
  if (v?.email?.trim()) r.club.push({ field: "email", value: v.email, next: normaliseEmail(v.email) });
  const idx = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(`SELECT to_regclass('public.users_email_lower_key') IS NOT NULL AS present`);
  r.indexPresent = !!idx[0]?.present;
  return r;
}

function blocked(r: Result): Set<string> {
  // A change is held back when its normalised value would collide in a unique column.
  const s = new Set<string>();
  for (const d of r.dups) for (const row of d.rows) s.add(`${d.col.table}.${d.col.column}:${row.id}`);
  return s;
}

async function apply(prisma: PrismaClient, r: Result): Promise<{ applied: number; held: number; indexCreated: boolean }> {
  const { audit } = await import("@/server/services/audit");
  const { SYSTEM } = await import("@/server/rbac/actor");
  const actor = { ...SYSTEM, name: "contacts:normalise" };
  const hold = blocked(r);
  let applied = 0;
  let held = 0;
  for (const ch of r.changes) {
    const key = `${ch.col.table}.${ch.col.column}:${ch.row.id}`;
    if (hold.has(key)) {
      held += 1;
      continue;
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE ${ch.col.table} SET ${ch.col.column} = $1 WHERE id = $2 AND ${ch.col.column} = $3`, ch.next, ch.row.id, ch.row.value);
      await audit(tx, actor, "contacts.normalise", ch.col.table, ch.row.id, { before: { [ch.col.column]: ch.row.value }, after: { [ch.col.column]: ch.next } });
    });
    applied += 1;
  }
  const clubChanges = r.club.filter((c) => c.next && c.next !== c.value);
  if (clubChanges.length) {
    await prisma.$transaction(async (tx) => {
      const row = await tx.setting.findUniqueOrThrow({ where: { key: "club" } });
      const before = row.value as Record<string, unknown>;
      const after = { ...before, ...Object.fromEntries(clubChanges.map((c) => [c.field, c.next])) };
      await tx.setting.update({ where: { key: "club" }, data: { value: after as Prisma.InputJsonValue } });
      await audit(tx, actor, "contacts.normalise", "setting", "club", { before: Object.fromEntries(clubChanges.map((c) => [c.field, c.value])), after: Object.fromEntries(clubChanges.map((c) => [c.field, c.next])) });
    });
    applied += clubChanges.length;
  }
  // Migration 0018 skips the case-insensitive email index while clashes exist; create it once they are gone.
  let indexCreated = false;
  if (!r.indexPresent) {
    const clash = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM users WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1 LIMIT 1`);
    if (!clash.length) {
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email))`);
      indexCreated = true;
    }
  }
  return { applied, held, indexCreated };
}

function table(head: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

const LIMIT = 100;
function section(r: Result, mode: string, outcome: string | null): string {
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const ref = (c: Col, row: Row) => `${c.table} ${row.ref ?? ""} (${row.id.slice(0, 10)})`.replace(/ +/g, " ");
  const totalInvalid = r.invalid.length;
  const out: string[] = [
    `<!-- section:${r.db} -->`,
    `## Database \`${r.db}\` — ${mode}, ${when} IST`,
    "",
    ...(outcome ? [outcome, ""] : []),
    table(
      ["Column", "Values", "Already canonical", mode === "applied" ? "Changed" : "Would change", "Invalid (left as is)", "Erased (DPDP)"],
      r.counts.map((c) => [`${c.col.label} — \`${c.col.table}.${c.col.column}\``, String(c.total), String(c.canonical), String(c.change), String(c.invalid), String(c.erased)]),
    ),
    "",
    `Club settings: ${r.club.length ? r.club.map((c) => `${c.field} ${c.next === null ? "**invalid** (left as is)" : c.next === c.value ? "canonical" : "would be normalised"}`).join(", ") : "no phone or email set yet"}.`,
    `Case-insensitive unique email index \`users_email_lower_key\`: ${r.indexPresent ? "present" : `absent — migration 0018 creates it on deploy${r.dups.some((d) => d.col.table === "users" && d.col.column === "email") ? "; **blocked by the clashing emails below** (`--apply` creates it once they are resolved)" : " (no clashing emails: nothing blocks it)"}`}.`,
    "",
    `### ${mode === "applied" ? "Changed" : "Would change"} (${r.changes.length}${r.changes.length > LIMIT ? `, first ${LIMIT}` : ""})`,
    "",
    r.changes.length
      ? table(["Record", "Column", "Stored (masked)", "Canonical (masked)"], r.changes.slice(0, LIMIT).map((c) => [ref(c.col, c.row), c.col.column, mask(c.col.kind, c.row.value), mask(c.col.kind, c.next)]))
      : "Nothing — every valid value is already in canonical form.",
    "",
    `### Invalid values — left as they are, for staff to correct (${totalInvalid}${totalInvalid > LIMIT ? `, first ${LIMIT}` : ""})`,
    "",
    totalInvalid
      ? table(["Record", "Column", "Stored (masked)", "Why"], r.invalid.slice(0, LIMIT).map((i) => [ref(i.col, i.row), i.col.column, mask(i.col.kind, i.row.value), i.reason]))
      : "None.",
    "",
    `### Duplicates in unique columns after normalisation — not merged, not deleted (${r.dups.length})`,
    "",
    r.dups.length
      ? table(
          ["Column", "Normalised value (masked)", "Records", "Cause"],
          r.dups.map((d) => [`${d.col.table}.${d.col.column}`, mask(d.col.kind, d.value), d.rows.map((x) => ref(d.col, x)).join("; "), d.createdByNormalisation ? "created by normalisation (held back by --apply)" : "already equal ignoring case"]),
        )
      : "None.",
    `<!-- /section:${r.db} -->`,
  ];
  return out.join("\n");
}

function writeReport(sectionText: string, db: string) {
  const header = [
    "# Contacts normalisation report (v5 §2.2)",
    "",
    "Produced by `npm run contacts:normalise` (`scripts/contacts-normalise.ts`). Dry run by default (read-only transaction);",
    "`--apply` writes the non-colliding changes with one audit row each (`contacts.normalise`) and creates the",
    "case-insensitive email index once clean. Canonical forms (src/lib/validation/contact.ts): mobile and landline →",
    "10 digits without +91/0 (e.g. `9811000001`); email → trimmed lower-case. Values are masked; records are named by",
    "member code / lead code / role and the first characters of the row id. Nothing is ever merged or deleted.",
    "",
  ].join("\n");
  let doc = existsSync(REPORT) ? readFileSync(REPORT, "utf8") : header;
  if (!doc.startsWith("# Contacts normalisation report")) doc = header + "\n" + doc;
  const re = new RegExp(`<!-- section:${db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -->[\\s\\S]*?<!-- /section:${db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -->`);
  doc = re.test(doc) ? doc.replace(re, sectionText) : `${doc.trimEnd()}\n\n${sectionText}\n`;
  writeFileSync(REPORT, doc.endsWith("\n") ? doc : `${doc}\n`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const db = dbName(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    // The scan never writes: a READ ONLY transaction makes that a database guarantee, not a promise.
    const r = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return scan(tx, db);
      },
      { timeout: 120_000 },
    );
    let outcome: string | null = null;
    if (APPLY) {
      const a = await apply(prisma, r);
      outcome = `Applied ${a.applied} change(s), each audited; held back ${a.held} that would collide.${a.indexCreated ? " Created `users_email_lower_key`." : ""}`;
      console.log(outcome);
    }
    writeReport(section(r, APPLY ? "applied" : "dry run", outcome), db);
    const invalid = r.invalid.length;
    console.log(`${db}: ${r.changes.length} to normalise, ${invalid} invalid, ${r.dups.length} duplicate group(s) → ${path.relative(process.cwd(), REPORT)}${APPLY ? "" : " (dry run — nothing written to the database)"}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
