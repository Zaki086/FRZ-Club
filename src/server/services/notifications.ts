// Notification centre (E-16, §5.16). In-app rows + email outbox. Every notification has a dedupe key,
// so the same event never notifies the same person twice.
import type { Role } from "@prisma/client";
import nodemailer from "nodemailer";
import { clock } from "@/lib/clock";
import { prisma, type Tx } from "../db";
import type { Actor } from "../rbac/actor";
import { assertUser } from "../rbac/permissions";
import { isEnabled } from "./capabilities";
import { logMessage } from "./messages";

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
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

type MailTransport = { sendMail(m: { from?: string; to: string; subject: string; text: string }): Promise<unknown> };
let testTransport: MailTransport | null = null;
/** Tests only: capture mail instead of talking to an SMTP server. */
export function setMailTransportForTests(t: MailTransport | null) {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) throw new Error("mail transport override is only available in tests");
  testTransport = t;
}
export function mailTransport(): MailTransport {
  if (testTransport) return testTransport;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

/**
 * Queue an email in the outbox (sent by the worker after commit). Completion pass §3: only when email is really
 * available (SMTP set up and verified by a test email); otherwise nothing is queued and nothing is promised.
 */
export async function queueEmail(tx: Tx, e: { to: string; subject: string; body: string; dedupeKey?: string }) {
  if (!(await isEnabled("email"))) return false;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO email_outbox (id, "to", subject, body, dedupe_key, updated_at)
    VALUES (${"eml_" + cryptoId()}, ${e.to}, ${e.subject}, ${e.body}, ${e.dedupeKey ?? null}, now())
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
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
  if (!(await isEnabled("email")) || (!smtpConfigured() && !testTransport)) {
    // Email was switched off after these were queued: they are not sent, and the log says so.
    await prisma.emailOutbox.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { error: "Email is not available (SMTP not set up or not verified)" } });
    for (const m of pending) await logMessage(prisma, { channel: "EMAIL", to: m.to, subject: m.subject, body: m.body, status: "FAILED", error: "Email is not available" });
    return { sent: 0, skipped: pending.length, failed: 0 };
  }
  const transport = mailTransport();
  let sent = 0;
  let failed = 0;
  for (const m of pending) {
    try {
      await transport.sendMail({ from: process.env.SMTP_FROM, to: m.to, subject: m.subject, text: m.body });
      await prisma.emailOutbox.update({ where: { id: m.id }, data: { sentAt: clock.now() } });
      await logMessage(prisma, { channel: "EMAIL", to: m.to, subject: m.subject, body: m.body, status: "SENT" });
      sent++;
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err.message.slice(0, 500) : String(err);
      await prisma.emailOutbox.update({ where: { id: m.id }, data: { error } });
      await logMessage(prisma, { channel: "EMAIL", to: m.to, subject: m.subject, body: m.body, status: "FAILED", error });
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
