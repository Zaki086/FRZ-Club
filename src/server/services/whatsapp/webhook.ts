// v4 §5.4 step 6: Meta's WhatsApp webhook (`/api/whatsapp/webhook`).
//   GET  — subscription handshake: `hub.verify_token` must equal WHATSAPP_WEBHOOK_VERIFY_TOKEN; echoes `hub.challenge`.
//   POST — `X-Hub-Signature-256` = HMAC-SHA256 of the RAW body with WHATSAPP_APP_SECRET, else rejected. Then:
//          · delivery statuses by wamid: sent → delivered → read, or failed + error code; never backwards; idempotent;
//            a failure queues the manual fallback task ("Messages to send") with the same text;
//          · inbound "STOP" (any case) → WhatsApp opt-out for that phone + an in-app confirmation;
//          · any other inbound message → a "Member replied on WhatsApp" task for the front desk (wa.me link).
// Every inbound message is stored once by its Meta id, so a webhook delivered twice acts once.
import { createHmac, timingSafeEqual } from "node:crypto";
import { clock } from "@/lib/clock";
import { prisma, withTx, type Tx } from "../../db";
import { DomainError } from "../../errors";
import { SYSTEM } from "../../rbac/actor";
import { audit } from "../audit";
import { whatsappFallback } from "../channels";
import { notify } from "../notifications";
import { toWhatsAppNumber, writeHealth } from "./config";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** WA-40: GET handshake. Returns the challenge to echo; FORBIDDEN otherwise. Success is recorded for Settings. */
export async function verifyWebhookSubscription(params: URLSearchParams): Promise<string> {
  const expected = (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "").trim();
  const given = params.get("hub.verify_token") ?? "";
  if (params.get("hub.mode") !== "subscribe" || !expected || !safeEqual(given, expected)) {
    throw new DomainError("FORBIDDEN", "Webhook verification failed.");
  }
  await writeHealth({ webhook_verified_at: clock.now().toISOString() });
  return params.get("hub.challenge") ?? "";
}

/** WA-41: is this the body Meta signed? (HMAC-SHA256 with the app secret over the exact raw bytes.) */
export function validWebhookSignature(rawBody: string | Buffer, signature: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET ?? "";
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signature.slice(7).toLowerCase());
}

// ───────── payload (only the fields we use) ─────────
type WaStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
};
type WaInbound = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
};
type WaValue = {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  statuses?: WaStatus[];
  messages?: WaInbound[];
};
type WaPayload = { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: WaValue }> }> };

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
const at = (ts: string | undefined) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : clock.now();
};

/**
 * Handle one signed webhook POST. Returns what changed (statuses applied, inbound messages handled). Statuses for
 * unknown message ids and changes for another phone number are ignored (200, so Meta does not retry them).
 */
export async function handleWebhook(rawBody: string, signature: string | null): Promise<{ statuses: number; inbound: number }> {
  if (!validWebhookSignature(rawBody, signature)) throw new DomainError("FORBIDDEN", "Missing or invalid signature.");
  let body: WaPayload;
  try {
    body = JSON.parse(rawBody) as WaPayload;
  } catch {
    throw new DomainError("VALIDATION_FAILED", "The webhook body is not JSON.");
  }
  // A correctly signed POST also proves the webhook is connected.
  const health = await prisma.setting.findUnique({ where: { key: "whatsapp_health" } });
  if (!(health?.value as { webhook_verified_at?: string | null } | null)?.webhook_verified_at) await writeHealth({ webhook_verified_at: clock.now().toISOString() });

  const ourNumber = (process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const out = { statuses: 0, inbound: 0 };
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v || (change.field && change.field !== "messages")) continue;
      if (ourNumber && v.metadata?.phone_number_id && v.metadata.phone_number_id !== ourNumber) continue;
      for (const st of v.statuses ?? []) if ((await applyStatus(st)).applied) out.statuses++;
      for (const m of v.messages ?? []) {
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        if (await handleInbound(m, name)) out.inbound++;
      }
    }
  }
  return out;
}

type Applied = { applied: boolean };
const NOT_APPLIED: Applied = { applied: false };

/** WA-42: one status update for one wamid. Never moves backwards; a repeat changes nothing. */
async function applyStatus(st: WaStatus): Promise<Applied> {
  if (!st.id || !st.status) return NOT_APPLIED;
  const status = st.status.toLowerCase();
  if (!(status in RANK) && status !== "failed") return NOT_APPLIED;
  const when = at(st.timestamp);
  return withTx(async (tx): Promise<Applied> => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM notification_deliveries WHERE provider_id = ${st.id} AND channel = 'WHATSAPP_API' FOR UPDATE`;
    if (!rows.length) return NOT_APPLIED;
    const d = await tx.notificationDelivery.findUniqueOrThrow({ where: { id: rows[0].id } });
    const cur = d.waStatus;
    if (cur === "failed") return NOT_APPLIED; // terminal
    if (status === "failed") {
      if (cur === "delivered" || cur === "read") return NOT_APPLIED; // it already reached the phone: never backwards
      const e = st.errors?.[0];
      const reason = [`WhatsApp could not deliver it${e?.code != null ? ` (#${e.code})` : ""}`, e?.title ?? e?.message, e?.error_data?.details].filter(Boolean).join(": ").slice(0, 500);
      await tx.notificationDelivery.update({
        where: { id: d.id },
        data: { waStatus: "failed", waFailedAt: when, waErrorCode: typeof e?.code === "number" ? e.code : null, status: "FAILED", error: reason },
      });
      await audit(tx, SYSTEM, "whatsapp.status", "notification_delivery", d.id, { before: { waStatus: cur, status: d.status }, after: { waStatus: "failed", status: "FAILED", code: e?.code ?? null } });
      // §5.4 step 7: Meta could not deliver it → the same message goes to the desk's "Messages to send".
      await whatsappFallback(d.id, reason, tx);
      return { applied: true };
    }
    const data: Record<string, unknown> = {};
    if (status === "sent" && !d.waSentAt) data.waSentAt = when;
    if (status === "delivered" && !d.deliveredAt) data.deliveredAt = when;
    if (status === "read") {
      if (!d.waReadAt) data.waReadAt = when;
      if (!d.deliveredAt) data.deliveredAt = when; // read implies delivered
    }
    if (!cur || RANK[status] > RANK[cur]) data.waStatus = status;
    if ((status === "delivered" || status === "read") && (d.status === "SENT" || d.status === "QUEUED")) data.status = "DELIVERED";
    if (!Object.keys(data).length) return NOT_APPLIED;
    await tx.notificationDelivery.update({ where: { id: d.id }, data });
    return { applied: true };
  });
}

function inboundText(m: WaInbound): string | null {
  switch (m.type) {
    case "text": return m.text?.body ?? null;
    case "button": return m.button?.text ?? m.button?.payload ?? null;
    case "interactive": return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    default: return null;
  }
}

/** WA-43: "STOP" (any case, optional punctuation) is an opt-out. */
export function isStopWord(text: string | null | undefined): boolean {
  return !!text && /^\s*stop[\s.!]*$/i.test(text);
}

/** People (members, guests, leads) whose phone is this WhatsApp number. Phones are stored as 10 digits. */
async function peopleByNumber(tx: Tx, from: string) {
  const ten = from.slice(2);
  const [members, guests, leads] = await Promise.all([
    tx.member.findMany({ where: { phone: ten, anonymisedAt: null }, select: { id: true, name: true, userId: true } }),
    tx.guest.findMany({ where: { phone: ten }, select: { id: true, name: true } }),
    tx.lead.findMany({ where: { phone: ten }, select: { id: true, name: true } }),
  ]);
  return { ten, members, guests, leads };
}

/** True when this inbound message was handled now (false: seen before, or not something we act on). */
async function handleInbound(m: WaInbound, profileName: string | null): Promise<boolean> {
  const from = m.from ? toWhatsAppNumber(m.from) : null;
  if (!m.id || !from) return false;
  const text = inboundText(m);
  const when = at(m.timestamp);
  return withTx(async (tx) => {
    const stop = isStopWord(text);
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO whatsapp_inbound (id, from_phone, type, text, handled_as, received_at)
      VALUES (${m.id}, ${from}, ${m.type ?? "unknown"}, ${text ? text.slice(0, 2000) : null}, ${stop ? "STOP" : "TASK"}, ${when})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (!inserted.length) return false; // already handled
    const people = await peopleByNumber(tx, from);
    if (stop) {
      await optOut(tx, from, people, when, m.id!);
      return true;
    }
    const deliveryId = await replyTask(tx, from, people, profileName, text ?? `[${m.type ?? "message"}]`, m.id!);
    await tx.whatsappInbound.update({ where: { id: m.id! }, data: { deliveryId } });
    return true;
  });
}

async function optOut(tx: Tx, from: string, people: Awaited<ReturnType<typeof peopleByNumber>>, when: Date, wamid: string) {
  const { ten, members } = people;
  await tx.member.updateMany({ where: { phone: ten }, data: { whatsappOptOutAt: when } });
  await tx.guest.updateMany({ where: { phone: ten }, data: { whatsappOptOutAt: when } });
  await tx.lead.updateMany({ where: { phone: ten }, data: { whatsappOptOutAt: when } });
  const userIds = members.map((x) => x.userId).filter((x): x is string => !!x);
  // STOP covers every WhatsApp from the club: the member's WhatsApp channel goes off too (manual messages included).
  if (userIds.length) await tx.user.updateMany({ where: { id: { in: userIds } }, data: { notifyWhatsapp: false } });
  // Anything still waiting for this number is not sent.
  await tx.notificationDelivery.updateMany({
    where: { toAddress: from, channel: { in: ["WHATSAPP_API", "WHATSAPP_MANUAL"] }, status: "QUEUED", handledBy: null },
    data: { status: "SKIPPED", error: "The person replied STOP on WhatsApp" },
  });
  if (userIds.length) {
    await notify(tx, {
      userIds,
      type: "WHATSAPP_OPT_OUT",
      title: "WhatsApp updates turned off",
      body: "You replied STOP on WhatsApp, so the club will not send you WhatsApp messages any more. You still get updates in the app. You can turn WhatsApp back on under Notifications.",
      link: "/portal/notifications",
      dedupeKey: `wa-stop:${wamid}`,
    });
  }
  await audit(tx, SYSTEM, "whatsapp.opt_out", "whatsapp_inbound", wamid, { after: { phone: `******${ten.slice(-4)}`, members: members.map((x) => x.id), guests: people.guests.map((x) => x.id), leads: people.leads.map((x) => x.id) } });
}

/** WA-44: a task in "Messages to send": who wrote, what they wrote, and a wa.me button to answer from the club phone. */
async function replyTask(tx: Tx, from: string, people: Awaited<ReturnType<typeof peopleByNumber>>, profileName: string | null, text: string, wamid: string): Promise<string> {
  const member = people.members.find((x) => x.userId) ?? people.members[0] ?? null;
  const name = member?.name ?? people.guests[0]?.name ?? people.leads[0]?.name ?? profileName?.trim() ?? null;
  // A manual row names a login (user) or a guest. A member without a login, or a number we don't know, is reached
  // through a guest row for that phone (found or created with the name we have).
  const userId: string | null = member?.userId ?? null;
  let guestId: string | null = null;
  if (!userId) {
    const g = people.guests[0] ?? (await tx.guest.create({ data: { name: (name ?? `WhatsApp +${from}`).slice(0, 120), phone: people.ten }, select: { id: true, name: true } }));
    guestId = g.id;
  }
  const who = name ?? `+${from}`;
  // One open task per number: a second message before anyone answered is added to it.
  const open = await tx.notificationDelivery.findFirst({ where: { event: "WHATSAPP_REPLY", channel: "WHATSAPP_MANUAL", toAddress: from, status: "QUEUED" }, orderBy: { createdAt: "desc" } });
  if (open) {
    await tx.notificationDelivery.update({ where: { id: open.id }, data: { body: `${open.body}\n${text.replace(/\s+/g, " ").trim()}`.slice(-2000) } });
    return open.id;
  }
  const first = (name ?? "").trim().split(/\s+/)[0];
  const d = await tx.notificationDelivery.create({
    data: {
      event: "WHATSAPP_REPLY", dedupeKey: `wa-in:${wamid}`, channel: "WHATSAPP_MANUAL", status: "QUEUED", userId, guestId, memberId: member?.id ?? null,
      toAddress: from, title: `${member ? "Member" : "Someone"} replied on WhatsApp: ${who}`.slice(0, 200), body: text.replace(/\s+/g, " ").trim().slice(0, 2000),
      link: member ? `/app/members/${member.id}` : null, whatsappText: first ? `Hi ${first}, ` : "", triggeredBy: "system",
    },
  });
  await audit(tx, SYSTEM, "whatsapp.reply_task", "notification_delivery", d.id, { after: { from: `******${people.ten.slice(-4)}`, member: member?.id ?? null } });
  return d.id;
}
