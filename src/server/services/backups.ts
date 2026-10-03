// Backups (completion pass 8.6): a nightly custom-format pg_dump into BACKUP_DIR, kept for 14 days, checked
// (the file must start with the PGDMP signature), recorded in settings.last_backup, and listed for the Owner, who
// can also run one now and download any of them. A failure notifies the Owner.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { DomainError } from "../errors";
import { SYSTEM, type Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { notify } from "./notifications";
import { getSettings, updateSetting } from "./settings";

export const KEEP_DAYS = 14;
const FILE_RE = /^club-\d{8}-\d{6}\.dump$/;

export const backupDir = () => path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.BACKUP_DIR ?? "backups");

/** pg_dump command: inside the Postgres container when BACKUP_PG_CONTAINER is set (matching server version). */
function dumpCommand(): { cmd: string; args: string[] } {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const db = url.pathname.replace(/^\//, "");
  const user = decodeURIComponent(url.username);
  const container = process.env.BACKUP_PG_CONTAINER;
  if (container) return { cmd: "docker", args: ["exec", container, "pg_dump", "-U", user, "-d", db, "-Fc"] };
  url.search = "";
  return { cmd: "pg_dump", args: ["-Fc", "--dbname", url.toString()] };
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function dumpTo(file: string): Promise<void> {
  const { cmd, args } = dumpCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = createWriteStream(file);
    let err = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      out.close();
      if (code === 0) resolve();
      else reject(new Error(err.trim().slice(0, 400) || `${cmd} exited with code ${code}`));
    });
  });
  const fh = await open(file, "r");
  const buf = Buffer.alloc(5);
  await fh.read(buf, 0, 5, 0);
  await fh.close();
  if (buf.toString() !== "PGDMP") throw new Error("The backup file is not a valid PostgreSQL dump.");
}

/** Remove backups older than KEEP_DAYS (the newest 3 always stay). */
async function prune(dir: string) {
  const files = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort().reverse();
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  let removed = 0;
  for (const [i, f] of files.entries()) {
    if (i < 3) continue;
    if ((await stat(path.join(dir, f))).mtimeMs < cutoff) {
      await rm(path.join(dir, f));
      removed++;
    }
  }
  return removed;
}

export async function runBackup(trigger: "nightly" | "manual", actor: Actor = SYSTEM) {
  if (trigger === "manual") assertCan(actor, "settings");
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const file = `club-${stamp(new Date())}.dump`;
  const full = path.join(dir, file);
  const at = new Date().toISOString();
  try {
    await dumpTo(full);
    const bytes = (await stat(full)).size;
    const removed = await prune(dir);
    await updateSetting(SYSTEM, "last_backup", { at, file, bytes, ok: true, error: null });
    await audit(prisma, actor, "backup.created", "backup", file, { after: { trigger, bytes, removed } });
    return { file, bytes, removed };
  } catch (e) {
    await rm(full, { force: true });
    const error = e instanceof Error ? e.message : String(e);
    await updateSetting(SYSTEM, "last_backup", { at, file, bytes: 0, ok: false, error });
    await prisma.$transaction((tx) =>
      notify(tx, { roles: ["OWNER"], type: "BACKUP_FAILED", title: "Database backup failed", body: error.slice(0, 300), link: "/app/settings/backups", dedupeKey: `backup-failed:${at}` }),
    );
    if (trigger === "manual") throw new DomainError("VALIDATION_FAILED", `The backup failed: ${error}`);
    return { file: null, bytes: 0, removed: 0, error };
  }
}

export async function listBackups(actor: Actor) {
  assertCan(actor, "settings");
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort().reverse();
  const files = [];
  for (const f of names) {
    const st = await stat(path.join(dir, f));
    files.push({ file: f, bytes: st.size, at: st.mtime.toISOString() });
  }
  return { last: (await getSettings()).last_backup, keepDays: KEEP_DAYS, dir, files };
}

/** Path of a backup the Owner may download (name checked against the pattern: no path tricks). */
export function backupPath(actor: Actor, file: string): string {
  assertCan(actor, "settings");
  if (!FILE_RE.test(file)) throw new DomainError("NOT_FOUND", "Backup was not found.");
  return path.join(backupDir(), file);
}
