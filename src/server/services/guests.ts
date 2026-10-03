// Guests (walk-ins, trial visitors, bar guests). Phone is unique when present, so creation is an atomic upsert:
// two simultaneous requests for the same new phone get the same guest row instead of a unique-violation error.
import type { Guest } from "@prisma/client";
import type { Tx } from "../db";

export async function findOrCreateGuest(tx: Tx, g: { name: string; phone?: string | null; email?: string | null }): Promise<Guest> {
  if (!g.phone) return tx.guest.create({ data: { name: g.name, phone: null, email: g.email ?? null } });
  const id = `gst_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO guests (id, name, phone, email, updated_at) VALUES (${id}, ${g.name}, ${g.phone}, ${g.email ?? null}, now())
    ON CONFLICT (phone) DO UPDATE SET email = coalesce(guests.email, EXCLUDED.email)
    RETURNING id`;
  return tx.guest.findUniqueOrThrow({ where: { id: rows[0].id } });
}
