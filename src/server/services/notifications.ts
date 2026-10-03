// Notification centre (E-16, §5.16). In-app rows + email outbox. Every notification has a dedupe key,
// so the same event never notifies the same person twice.
import type { Role } from "@prisma/client";
import nodemailer from "nodemailer";
import { clock } from "@/lib/clock";
import { prisma, type Tx } from "../db";
import type { Actor } from "../rbac/actor";
import { assertUser } from "../rbac/permissions";

export type NotifyInput = {
  type: string;
  title: string;
  body: string;
  link?: string | null;
  dedupeKey: string;
  userIds?: string[];
  roles?: Role[];
  /** Also email these users (if they have an email address). */
  email?: boolean;
};

/** Create in-app notifications (deduped per user) and optionally queue emails. */
export async function notify(tx: Tx, n: NotifyInput): Promise<number> {
  const ids = new Set(n.userIds ?? []);
  if (n.roles?.length) {
    const users = await tx.user.findMany({ where: { role: { in: n.roles }, active: true }, select: { id: true } });
    users.forEach((u) => ids.add(u.id));
  }
  let created = 0;
  for (const userId of ids) {
    const dedupeKey = `${n.dedupeKey}:${userId}`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO notifications (id, user_id, type, title, body, link, dedupe_key, updated_at)
      VALUES (${"ntf_" + cryptoId()}, ${userId}, ${n.type}, ${n.title}, ${n.body}, ${n.link ?? null}, ${dedupeKey}, now())
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
    if (rows.length && n.email) {
      const u = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (u?.email) await queueEmail(tx, { to: u.email, subject: n.title, body: n.body, dedupeKey });
    }
    created += rows.length;
  }
  return created;
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function smtpConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

/** Queue an email in the outbox (sent by the worker after commit). Never throws for missing SMTP. */
export async function queueEmail(tx: Tx, e: { to: string; subject: string; body: string; dedupeKey?: string }) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO email_outbox (id, "to", subject, body, dedupe_key, updated_at)
    VALUES (${"eml_" + cryptoId()}, ${e.to}, ${e.subject}, ${e.body}, ${e.dedupeKey ?? null}, now())
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
  if (rows.length && !smtpConfigured() && process.env.NODE_ENV !== "test" && !process.env.VITEST && !process.env.SEEDING) {
    console.log(`[email→outbox] to=${e.to} subject="${e.subject}"`);
  }
  return rows.length > 0;
}

/** Worker job: deliver queued emails over SMTP, or record why they could not be sent. Idempotent. */
export async function flushEmailOutbox(limit = 50): Promise<{ sent: number; skipped: number; failed: number }> {
  const pending = await prisma.emailOutbox.findMany({
    where: { sentAt: null, error: null },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (!pending.length) return { sent: 0, skipped: 0, failed: 0 };
  if (!smtpConfigured()) {
    await prisma.emailOutbox.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { error: "SMTP not configured — kept in outbox and logged to console" },
    });
    return { sent: 0, skipped: pending.length, failed: 0 };
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  let sent = 0;
  let failed = 0;
  for (const m of pending) {
    try {
      await transport.sendMail({ from: process.env.SMTP_FROM, to: m.to, subject: m.subject, text: m.body });
      await prisma.emailOutbox.update({ where: { id: m.id }, data: { sentAt: clock.now() } });
      sent++;
    } catch (err) {
      failed++;
      await prisma.emailOutbox.update({
        where: { id: m.id },
        data: { error: err instanceof Error ? err.message.slice(0, 500) : String(err) },
      });
    }
  }
  return { sent, skipped: 0, failed };
}

// ───────── read side (notification centre) ─────────

export async function listMyNotifications(actor: Actor, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  assertUser(actor);
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: actor.userId, readAt: opts.unreadOnly ? null : undefined },
      orderBy: { createdAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
    }),
    prisma.notification.count({ where: { userId: actor.userId, readAt: null } }),
  ]);
  return { items, unread };
}

export async function markNotificationsRead(actor: Actor, ids: string[] | "all") {
  assertUser(actor);
  const res = await prisma.notification.updateMany({
    where: { userId: actor.userId, readAt: null, id: ids === "all" ? undefined : { in: ids } },
    data: { readAt: clock.now() },
  });
  return { updated: res.count };
}
