// v5 §3.2: the one-click unsubscribe link in ANNOUNCEMENT emails (TRANSACTIONAL emails never carry it).
// Token: `UN1.<m|l>.<member or lead id>.<hmac>` — HMAC-SHA256 with APP_SECRET over the first three parts, base64url.
// It carries no personal data and doesn't expire (an old newsletter's link must still work). Applying it sets
// `email_announcements_opt_out` on the member (or lead); "Subscribe again" clears it. Both are audited.
import { createHmac, timingSafeEqual } from "node:crypto";
import { clock } from "@/lib/clock";
import { prisma, withTx } from "../../db";
import { DomainError } from "../../errors";
import { PUBLIC } from "../../rbac/actor";
import { audit } from "../audit";
import { getSettings } from "../settings";
import { absoluteUrl } from "./records";

const PREFIX = "UN1";
type Kind = "m" | "l";

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s) throw new Error("APP_SECRET is not set");
  return s;
}

function mac(body: string): string {
  return createHmac("sha256", secret()).update(`unsubscribe:${body}`).digest("base64url").slice(0, 32);
}

/** The unsubscribe token of a member ("m") or a lead ("l"). */
export function signUnsubscribeToken(kind: Kind, id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("invalid id for an unsubscribe token");
  const body = `${PREFIX}.${kind}.${id}`;
  return `${body}.${mac(body)}`;
}

/** The person when the token is authentic (constant-time check), otherwise null. */
export function verifyUnsubscribeToken(token: string): { kind: Kind; id: string } | null {
  let text: string;
  try {
    text = decodeURIComponent(String(token ?? "")).trim();
  } catch {
    return null;
  }
  const parts = text.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX || (parts[1] !== "m" && parts[1] !== "l") || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[2])) return null;
  const expected = Buffer.from(mac(parts.slice(0, 3).join(".")));
  const given = Buffer.from(parts[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { kind: parts[1] as Kind, id: parts[2] };
}

/** The public page an announcement email links to (one click unsubscribes). */
export function unsubscribeUrl(kind: Kind, id: string): string {
  return absoluteUrl(`/unsubscribe/${signUnsubscribeToken(kind, id)}`);
}

/** POST target for mail clients' one-click unsubscribe (RFC 8058 List-Unsubscribe-Post). */
export function unsubscribePostUrl(kind: Kind, id: string): string {
  return absoluteUrl(`/api/messages/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(kind, id))}`);
}

export type UnsubscribeResult = { unsubscribed: boolean; clubName: string; firstName: string };

/** Unsubscribe (or subscribe again) from announcement emails. Idempotent; audited when it changes something. */
export async function applyUnsubscribe(token: string, opts: { resubscribe?: boolean } = {}): Promise<UnsubscribeResult> {
  const who = verifyUnsubscribeToken(token);
  if (!who) throw new DomainError("LINK_INVALID", "This unsubscribe link is not valid. Please use the link from the latest email.");
  const optOut = !opts.resubscribe;
  const now = clock.now();
  const name = await withTx(async (tx) => {
    const row = who.kind === "m"
      ? await tx.member.findUnique({ where: { id: who.id }, select: { name: true, emailAnnouncementsOptOut: true, anonymisedAt: true } })
      : await tx.lead.findUnique({ where: { id: who.id }, select: { name: true, emailAnnouncementsOptOut: true } });
    if (!row) throw new DomainError("LINK_INVALID", "This unsubscribe link is no longer valid.");
    if (row.emailAnnouncementsOptOut !== optOut) {
      const data = { emailAnnouncementsOptOut: optOut, emailAnnouncementsOptOutAt: optOut ? now : null };
      if (who.kind === "m") await tx.member.update({ where: { id: who.id }, data });
      else await tx.lead.update({ where: { id: who.id }, data });
      await audit(tx, PUBLIC, optOut ? "email.announcements_unsubscribe" : "email.announcements_resubscribe", who.kind === "m" ? "member" : "lead", who.id, {
        before: { optOut: row.emailAnnouncementsOptOut }, after: { optOut, at: now.toISOString(), via: "email link" },
      });
    }
    return row.name;
  });
  const club = (await getSettings()).club.name;
  return { unsubscribed: optOut, clubName: club, firstName: (name ?? "").trim().split(/\s+/)[0] ?? "" };
}

/** Is this member/lead unsubscribed from announcement emails? */
export async function announcementsOptedOut(kind: Kind, id: string): Promise<boolean> {
  const row = kind === "m"
    ? await prisma.member.findUnique({ where: { id }, select: { emailAnnouncementsOptOut: true } })
    : await prisma.lead.findUnique({ where: { id }, select: { emailAnnouncementsOptOut: true } });
  return !!row?.emailAnnouncementsOptOut;
}
