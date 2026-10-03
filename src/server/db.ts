// Prisma client + the one transaction helper every mutating service uses (plan §1.1 rule 3).
import { Prisma, PrismaClient } from "@prisma/client";
import { clock } from "@/lib/clock";

const g = globalThis as unknown as { __ccPrisma?: PrismaClient };

export const prisma: PrismaClient =
  g.__ccPrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG ? ["query", "warn", "error"] : ["warn"],
  });
g.__ccPrisma = prisma;

export type Tx = Prisma.TransactionClient;

const TX_TIMEOUT_MS = Number(process.env.TX_TIMEOUT_MS ?? 60_000);

/**
 * Run `fn` in one DB transaction. If `outer` is given (a service calling another service, or the seed),
 * the work joins that transaction instead of opening a new one.
 * Each new transaction pins `app.now` to the injectable clock so DB defaults (created_at) follow it.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, outer?: Tx): Promise<T> {
  if (outer) return fn(outer);
  const opened: { tx: Tx | null } = { tx: null };
  const result = await prisma.$transaction(
    async (tx) => {
      opened.tx = tx;
      await tx.$executeRaw`SELECT set_config('app.now', ${clock.now().toISOString()}, true)`;
      return fn(tx);
    },
    // Generous by default; TX_TIMEOUT_MS lets a loaded test machine wait longer instead of failing.
    { maxWait: TX_TIMEOUT_MS / 2, timeout: TX_TIMEOUT_MS },
  );
  if (opened.tx) runAfterCommit(opened.tx);
  return result;
}

// ───────── after commit (v4 §5.4: nothing is sent before the business transaction commits) ─────────
const afterCommitHooks = new WeakMap<Tx, Array<() => unknown>>();
const inFlight = new Set<Promise<unknown>>();

/**
 * Run `fn` once the transaction `tx` (opened by `withTx`) has committed — never when it rolls back. Hooks run in the
 * background in the order they were added; a failing hook is logged and changes nothing that was committed.
 */
export function afterCommit(tx: Tx, fn: () => unknown): void {
  const list = afterCommitHooks.get(tx);
  if (list) list.push(fn);
  else afterCommitHooks.set(tx, [fn]);
}

function runAfterCommit(tx: Tx) {
  const hooks = afterCommitHooks.get(tx);
  if (!hooks?.length) return;
  afterCommitHooks.delete(tx);
  const p = (async () => {
    for (const h of hooks) {
      try {
        await h();
      } catch (e) {
        console.error("[afterCommit] hook failed", e);
      }
    }
  })();
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/** Wait for every after-commit hook started so far (tests, and a worker that is about to exit). */
export async function settleAfterCommit(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

/** Next value of a Postgres sequence (human-readable codes, §2). */
export async function nextSeq(tx: Tx, sequence: string): Promise<number> {
  if (!/^[a-z_]+$/.test(sequence)) throw new Error(`bad sequence name ${sequence}`);
  const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT nextval('${sequence}') AS n`);
  return Number(rows[0].n);
}

/** SQLSTATE of a Postgres error surfaced through Prisma (raw or model queries), if any. */
export function pgErrorCode(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = e.meta as Record<string, unknown> | undefined;
    if (meta && typeof meta.code === "string") return meta.code;
    if (e.code === "P2002") return "23505";
    if (e.code === "P2004") {
      const m = /23P01|exclusion/i.exec(e.message);
      if (m) return "23P01";
    }
    const m = /\b(23P01|23505|23514|40P01|40001)\b/.exec(e.message);
    if (m) return m[1];
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    const m = /\b(23P01|23505|23514|40P01|40001)\b/.exec(e.message);
    if (m) return m[1];
    if (/conflicting key value violates exclusion constraint/i.test(e.message)) return "23P01";
  }
  return null;
}

/** Name of the violated constraint, if Prisma exposes it. */
export function pgConstraint(e: unknown): string | null {
  if (e instanceof Error) {
    const m = /constraint "([^"]+)"/.exec(e.message) ?? /constraint `([^`]+)`/.exec(e.message);
    if (m) return m[1];
    const meta = (e as { meta?: Record<string, unknown> }).meta;
    if (meta) {
      const t = meta.target;
      if (typeof t === "string") return t;
      if (Array.isArray(t)) return t.join(",");
      if (typeof meta.message === "string") {
        const mm = /constraint "([^"]+)"/.exec(meta.message);
        if (mm) return mm[1];
      }
    }
  }
  return null;
}
