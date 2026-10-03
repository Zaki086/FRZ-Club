// Idempotency keys (plan §2, E-23). Runs inside the caller's transaction:
// - first request inserts the key, runs the work, stores the response, commits together;
// - a concurrent duplicate blocks on the unique index until the first commits, then replays its response;
// - if the first failed (rolled back), the duplicate simply runs.
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Tx } from "../db";
import { DomainError } from "../errors";

export function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export type Idem = { key?: string | null; actorKey: string; endpoint: string; body: unknown };

/** JSON round-trip so a replay returns exactly what the first call returned. */
function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export async function idempotent<T>(tx: Tx, idem: Idem | undefined, work: () => Promise<T>): Promise<T> {
  if (!idem?.key) return jsonSafe(await work());
  const key = idem.key.slice(0, 200);
  const hash = requestHash(idem.body);
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO idempotency_keys (id, key, actor_key, endpoint, request_hash, updated_at)
    VALUES (${"idem_" + hash.slice(0, 12) + "_" + Math.random().toString(36).slice(2, 10)}, ${key}, ${idem.actorKey},
            ${idem.endpoint}, ${hash}, now())
    ON CONFLICT (key, actor_key) DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) {
    const existing = await tx.idempotencyKey.findUnique({
      where: { key_actorKey: { key, actorKey: idem.actorKey } },
    });
    if (!existing || existing.endpoint !== idem.endpoint || existing.requestHash !== hash) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This request key was already used for a different request. Refresh and try again.",
      );
    }
    if (existing.responseJson === null) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "The same request is still being processed. Please wait a moment.");
    }
    return existing.responseJson as T;
  }
  const result = jsonSafe(await work());
  await tx.idempotencyKey.update({
    where: { id: inserted[0].id },
    data: { responseJson: result as Prisma.InputJsonValue },
  });
  return result;
}
