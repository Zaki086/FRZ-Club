// v6 §2.3 (SENDALL) "Send all automatically" for the manual WhatsApp queue (Messages to Send).
//
// SA-0 (hard rule): automatic WhatsApp is sent ONLY through the official WhatsApp Cloud API (whatsapp/client.ts via
// channels.ts `dispatchWhatsApp`). Never automate WhatsApp Web or Desktop, simulate clicks or use unofficial
// libraries — that breaks WhatsApp's terms and gets the club's number banned. Without the API, WhatsApp is simply not
// sent automatically and the preflight says so (SA-9); email and push can still go instead.
//
// Flow:
//  - SA-6 preflight (reads only): per queued task matching the current filter — not relevant any more (SA-1),
//    duplicate (SA-2), expired (SA-3) or already reached by email/push → skipped; else WhatsApp through the API when the
//    API is on, the event's Meta template is mapped + APPROVED, the person opted in and the number is valid; else (when
//    "use other channels" is ticked) email and/or push instead; else "can't send automatically" with the reasons.
//    One rendered sample per channel.
//  - SA-7 confirm: a `bulk_send_jobs` row + one item per task, the skipped ones taken out of the queue — and the call
//    returns at once. SA-8: one QUEUED/RUNNING job per filter (a unique partial index); a second click gets the
//    running job back.
//  - The worker (`runSendAllJobs`, every minute and right after the confirm) sends each item with the existing
//    dispatchers: the WhatsApp API queue (retries with backoff, rate-limit pause → resumes by itself), email at ≤ 1 per
//    second (v5's shared rate gate) in the club's layout, Web Push per device (held in the quiet hours like every
//    push). Every message is rendered at send time (URL-3). A task sent on any channel → SENT_AUTOMATICALLY, linked to
//    its delivery rows (`task_id`, `bulk_job_id`); a task that could not be sent stays QUEUED with the reason.
//  - SA-10: the front desk sends TRANSACTIONAL tasks only; ANNOUNCEMENT tasks need a Manager or the Owner.
//  - SA-11: every message a job sends is in the Message Log with the job id, channel, status and error.
import { Prisma, type NotificationDelivery } from "@prisma/client";
import { z } from "zod";
import { clock } from "@/lib/clock";
import { prisma, withTx, type Tx } from "../../db";
import { DomainError } from "../../errors";
import { actorId, SYSTEM, type Actor } from "../../rbac/actor";
import { assertCan, can } from "../../rbac/permissions";
import { audit } from "../audit";
import { getCapabilities, type Capabilities } from "../capabilities";
import { channelPausedUntil, dispatchWhatsApp, inQuietHours, quietHoursEnd } from "../channels";
import { notificationsList } from "../filters/notifications";
import { listMatchingIds } from "../filters/core";
import { isOptedIn, templateFor, toWhatsAppNumber } from "../whatsapp/config";
import { buildTemplate, type WaMessage, type WaTemplateName } from "../whatsapp/templates";
import { takePermit } from "./bulk";
import { deliverRow, QUEUE_MARK } from "./delivery";
import {
  applyVerdicts, classifyTasks, isStillRelevant, parseSpec, renderDelivery, type RenderCache, type TaskVerdict,
} from "./manual-queue";
import type { ReasonCount, SendAllJob, SendAllPreflight, SendAllSample, SendAllStartResponse } from "./send-all-contract";
import { maskEmail, maskPhone } from "./variables";

export const sendAllSchema = z.object({
  filter: z.string().max(4000).default(""),
  useOtherChannels: z.boolean().default(true),
});
export type SendAllInput = z.input<typeof sendAllSchema>;

/** The claim a job puts on a manual task while sending it (and keeps once it is SENT_AUTOMATICALLY). */
const CLAIM = "sendall:";
const STALE_MS = 10 * 60_000;
const IGNORED_PARAMS = new Set(["page", "size", "sort", "view", "channel", "status"]);

type Channel = "WHATSAPP_API" | "EMAIL" | "PUSH";

// ───────── the queue under the current filter ─────────

function filterParams(filter: string): Record<string, string> {
  return Object.fromEntries([...new URLSearchParams(filter.replace(/^\?/, ""))].filter(([k, v]) => !IGNORED_PARAMS.has(k) && v !== ""));
}

/** SA-8: the normalised filter (sorted parameters) — one running job per key. */
export function filterKeyOf(filter: string): string {
  const p = filterParams(filter);
  const keys = Object.keys(p).sort();
  return keys.length ? keys.map((k) => `${k}=${p[k].split(",").sort().join(",")}`).join("&") : "all";
}

/** Every QUEUED manual WhatsApp task matching the Messages to Send filter (oldest first). */
async function queueTasks(actor: Actor, filter: string): Promise<NotificationDelivery[]> {
  const ids = await listMatchingIds(notificationsList, actor, { ...filterParams(filter), channel: "WHATSAPP_MANUAL", status: "QUEUED", sort: "oldest" }, 10_000);
  if (!ids.length) return [];
  return prisma.notificationDelivery.findMany({
    where: { id: { in: ids }, channel: "WHATSAPP_MANUAL", status: "QUEUED" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

// ───────── who the task reaches, and how ─────────

type Reach = {
  name: string;
  category: "TRANSACTIONAL" | "ANNOUNCEMENT";
  number: string | null;
  wa: { ok: true; template: string; language: string; params: string[]; buttonParam: string | null } | { ok: false; reason: string };
  email: { ok: true; to: string } | { ok: false; reason: string };
  push: { ok: true; devices: Array<{ id: string; userAgent: string | null }> } | { ok: false; reason: string };
  /** Channels that already carried this same message (the event's own email / push rows). */
  already: Set<"EMAIL" | "PUSH">;
};

type Contact = { name: string; email: string | null; emailOn: boolean; pushOn: boolean; userId: string | null; optedIn: boolean; announcementsOptOut: boolean };

async function contactOf(t: NotificationDelivery): Promise<Contact | null> {
  const fromMember = async (memberId: string) => {
    const m = await prisma.member.findUnique({ where: { id: memberId }, include: { user: { select: { id: true, email: true, active: true, notifyEmail: true, notifyPush: true } } } });
    if (!m || m.anonymisedAt) return null;
    const u = m.user?.active ? m.user : null;
    return { name: m.name, email: m.email ?? u?.email ?? null, emailOn: u?.notifyEmail ?? true, pushOn: u?.notifyPush ?? true, userId: u?.id ?? null, optedIn: isOptedIn(m), announcementsOptOut: m.emailAnnouncementsOptOut };
  };
  // System events go to the login they were addressed to (a Junior's guardian included); template messages to the
  // record's person.
  if (t.userId && !t.templateId) {
    const u = await prisma.user.findUnique({ where: { id: t.userId }, select: { id: true, name: true, email: true, notifyEmail: true, notifyPush: true } });
    if (!u) return null;
    const m = await prisma.member.findUnique({ where: { userId: u.id }, select: { whatsappOptInAt: true, whatsappOptOutAt: true, emailAnnouncementsOptOut: true } });
    return { name: u.name, email: u.email, emailOn: u.notifyEmail, pushOn: u.notifyPush, userId: u.id, optedIn: isOptedIn(m), announcementsOptOut: m?.emailAnnouncementsOptOut ?? false };
  }
  if (t.memberId) return fromMember(t.memberId);
  if (t.userId) {
    const m = await prisma.member.findUnique({ where: { userId: t.userId }, select: { id: true } });
    if (m) return fromMember(m.id);
  }
  if (t.guestId) {
    const g = await prisma.guest.findUnique({ where: { id: t.guestId } });
    return g ? { name: g.name, email: g.email ?? null, emailOn: true, pushOn: false, userId: null, optedIn: isOptedIn(g), announcementsOptOut: false } : null;
  }
  if (t.leadId) {
    const l = await prisma.lead.findUnique({ where: { id: t.leadId } });
    return l ? { name: l.name, email: l.email, emailOn: true, pushOn: false, userId: null, optedIn: isOptedIn(l), announcementsOptOut: l.emailAnnouncementsOptOut } : null;
  }
  const contact = t.recipientKey?.startsWith("contact:") ? t.recipientKey.slice("contact:".length) : null;
  if (contact) {
    const c = await prisma.businessClient.findUnique({ where: { id: contact } });
    return c ? { name: c.contactName, email: c.contactEmail ?? null, emailOn: true, pushOn: false, userId: null, optedIn: false, announcementsOptOut: false } : null;
  }
  return null;
}

type Ctx = { caps: Capabilities; templates: Map<string, { channels: string[]; waTemplate: string | null } | null>; render: RenderCache };

async function newCtx(): Promise<Ctx> {
  return { caps: await getCapabilities(), templates: new Map(), render: new Map() };
}

async function templateInfo(ctx: Ctx, id: string | null) {
  if (!id) return null;
  if (!ctx.templates.has(id)) ctx.templates.set(id, await prisma.messageTemplate.findUnique({ where: { id }, select: { channels: true, waTemplate: true } }));
  return ctx.templates.get(id)!;
}

async function reachOf(t: NotificationDelivery, ctx: Ctx): Promise<Reach> {
  const c = await contactOf(t);
  const number = toWhatsAppNumber(t.toAddress ?? "");
  const spec = parseSpec(t.renderSpec);
  const tpl = await templateInfo(ctx, t.templateId);
  const category = t.templateCategory === "ANNOUNCEMENT" ? "ANNOUNCEMENT" : "TRANSACTIONAL";

  // WhatsApp through the Cloud API (SA-6: API on + template mapped and approved + opted in + valid number).
  let wa: Reach["wa"];
  const waMsg: WaMessage | null = spec?.wa ?? null;
  if (!ctx.caps["whatsapp.api"].enabled) wa = { ok: false, reason: "WhatsApp API not set up" };
  else if (!number) wa = { ok: false, reason: "Invalid number" };
  else if (!waMsg) wa = { ok: false, reason: "No WhatsApp API template for this message" };
  else {
    const mapped = await templateFor(prisma as unknown as Tx, waMsg.template as WaTemplateName);
    if (!mapped || !mapped.approved) wa = { ok: false, reason: "Template not approved" };
    else if (!c?.optedIn) wa = { ok: false, reason: "Not opted in" };
    else {
      const built = buildTemplate(waMsg);
      wa = { ok: true, template: mapped.name, language: mapped.language, params: built.params, buttonParam: built.buttonParam };
    }
  }

  let email: Reach["email"];
  if (!ctx.caps.email.enabled) email = { ok: false, reason: "Email not set up" };
  else if (tpl && !tpl.channels.includes("EMAIL")) email = { ok: false, reason: "No email text in this template" };
  else if (!c?.email) email = { ok: false, reason: "No email" };
  else if (!c.emailOn) email = { ok: false, reason: "Turned off email" };
  else if (category === "ANNOUNCEMENT" && c.announcementsOptOut) email = { ok: false, reason: "Unsubscribed from announcement emails" };
  else email = { ok: true, to: c.email };

  let push: Reach["push"];
  if (!ctx.caps.push.enabled) push = { ok: false, reason: "Push not set up" };
  else if (tpl && !tpl.channels.includes("PUSH")) push = { ok: false, reason: "No push text in this template" };
  else if (!c?.userId || !c.pushOn) push = { ok: false, reason: c?.userId ? "Turned off push" : "No push subscription" };
  else {
    const devices = await prisma.pushSubscription.findMany({ where: { userId: c.userId }, select: { id: true, userAgent: true }, orderBy: { createdAt: "asc" } });
    push = devices.length ? { ok: true, devices } : { ok: false, reason: "No push subscription" };
  }

  // The same message's own email / push rows (a v4 event goes out on every channel at once).
  const siblings = await prisma.notificationDelivery.findMany({
    where: {
      OR: [{ dedupeKey: t.dedupeKey }, { dedupeKey: { startsWith: `${t.dedupeKey}:` }, templateId: { not: null } }],
      channel: { in: ["EMAIL", "PUSH"] }, status: { in: ["QUEUED", "SENT", "DELIVERED"] }, taskId: null,
    },
    select: { channel: true },
  });
  const already = new Set(siblings.map((s) => s.channel as "EMAIL" | "PUSH"));
  return { name: c?.name ?? t.title, category, number, wa, email, push, already };
}

type Route =
  | { kind: "SEND"; channels: Channel[] }
  | { kind: "SKIP"; reason: string }
  | { kind: "CANNOT"; reasons: string[] };

/** Which channels a task goes out on (WhatsApp API first; email / push instead only when allowed and possible). */
function routeOf(r: Reach, useOtherChannels: boolean): Route {
  if (r.wa.ok) return { kind: "SEND", channels: ["WHATSAPP_API"] };
  const reasons = [r.wa.reason];
  if (!useOtherChannels) return { kind: "CANNOT", reasons };
  const channels: Channel[] = [];
  if (r.email.ok && !r.already.has("EMAIL")) channels.push("EMAIL");
  if (r.push.ok && !r.already.has("PUSH")) channels.push("PUSH");
  if (channels.length) return { kind: "SEND", channels };
  if ((r.email.ok && r.already.has("EMAIL")) || (r.push.ok && r.already.has("PUSH"))) {
    return { kind: "SKIP", reason: `Already reached by ${r.already.has("EMAIL") && r.email.ok ? "email" : "push"}` };
  }
  if (!r.email.ok) reasons.push(r.email.reason);
  if (!r.push.ok) reasons.push(r.push.reason);
  return { kind: "CANNOT", reasons };
}

// ───────── SA-6 preflight ─────────

type Plan = {
  filterKey: string;
  tasks: NotificationDelivery[];
  verdicts: Map<string, TaskVerdict>;
  items: Array<{ task: NotificationDelivery; channels: Channel[]; reach: Reach }>;
  cannot: Array<{ task: NotificationDelivery; reasons: string[] }>;
  excludedAnnouncements: number;
  whatsappOn: boolean;
  whatsappReason: string | null;
};

function assertSendAll(actor: Actor) {
  assertCan(actor, "messages.send_all");
}

async function plan(actor: Actor, input: z.output<typeof sendAllSchema>, ctx: Ctx): Promise<Plan> {
  const tasks = await queueTasks(actor, input.filter);
  const announce = can(actor, "messages.announce");
  const own = tasks.filter((t) => announce || t.templateCategory !== "ANNOUNCEMENT");
  const verdicts = await classifyTasks(own);
  const items: Plan["items"] = [];
  const cannot: Plan["cannot"] = [];
  for (const t of own) {
    if (verdicts.get(t.id)?.status !== "OK") continue;
    const reach = await reachOf(t, ctx);
    const r = routeOf(reach, input.useOtherChannels);
    if (r.kind === "SEND") items.push({ task: t, channels: r.channels, reach });
    else if (r.kind === "SKIP") verdicts.set(t.id, { status: "SKIPPED_DUPLICATE", reason: r.reason });
    else cannot.push({ task: t, reasons: r.reasons });
  }
  return {
    filterKey: filterKeyOf(input.filter), tasks, verdicts, items, cannot, excludedAnnouncements: tasks.length - own.length,
    whatsappOn: ctx.caps["whatsapp.api"].enabled, whatsappReason: ctx.caps["whatsapp.api"].enabled ? null : ctx.caps["whatsapp.api"].reason,
  };
}

function countReasons(list: string[]): ReasonCount[] {
  const m = new Map<string, number>();
  for (const r of list) m.set(r, (m.get(r) ?? 0) + 1);
  return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

async function samples(p: Plan, ctx: Ctx): Promise<SendAllSample> {
  const out: SendAllSample = {};
  const wa = p.items.find((i) => i.channels.includes("WHATSAPP_API"));
  if (wa && wa.reach.wa.ok) {
    const r = await renderDelivery(wa.task, ctx.render);
    out.whatsapp = { to: maskPhone(wa.reach.number), template: wa.reach.wa.template, params: wa.reach.wa.params, text: r.whatsappText };
  }
  const em = p.items.find((i) => i.channels.includes("EMAIL"));
  if (em && em.reach.email.ok) {
    const r = await renderDelivery({ ...em.task, channel: "EMAIL" }, ctx.render);
    out.email = { to: maskEmail(em.reach.email.to), subject: r.title, text: [r.body, r.link ?? ""].filter(Boolean).join("\n\n") };
  }
  const pu = p.items.find((i) => i.channels.includes("PUSH"));
  if (pu) {
    const r = await renderDelivery({ ...pu.task, channel: "PUSH" }, ctx.render);
    out.push = { title: r.title, body: r.body };
  }
  return out;
}

const SETUP_HREF = "/app/settings?tab=whatsapp";

/** POST /api/messages/send-all/preflight — what "Send all" would do now (nothing is sent or changed). */
export async function sendAllPreflight(actor: Actor, raw: unknown): Promise<SendAllPreflight> {
  assertSendAll(actor);
  const input = sendAllSchema.parse(raw ?? {});
  const ctx = await newCtx();
  const p = await plan(actor, input, ctx);
  const skippedReasons = [...p.verdicts.values()].filter((v): v is Exclude<TaskVerdict, { status: "OK" }> => v.status !== "OK");
  const running = await prisma.bulkSendJob.findFirst({ where: { filterKey: p.filterKey, status: { in: ["QUEUED", "RUNNING"] } } });
  return {
    filterKey: p.filterKey,
    total: p.tasks.length,
    whatsappApi: { on: p.whatsappOn, reason: p.whatsappReason },
    buttonLabel: p.whatsappOn ? "Send all" : "Send all by email & push",
    setupHref: !p.whatsappOn && can(actor, "settings") ? SETUP_HREF : null,
    useOtherChannels: input.useOtherChannels,
    willSend: {
      tasks: p.items.length,
      whatsapp: p.items.filter((i) => i.channels.includes("WHATSAPP_API")).length,
      email: p.items.filter((i) => i.channels.includes("EMAIL")).length,
      push: p.items.filter((i) => i.channels.includes("PUSH")).length,
    },
    skipped: {
      total: skippedReasons.length,
      notRelevant: skippedReasons.filter((v) => v.status === "SKIPPED_NOT_RELEVANT").length,
      duplicate: skippedReasons.filter((v) => v.status === "SKIPPED_DUPLICATE").length,
      expired: skippedReasons.filter((v) => v.status === "EXPIRED").length,
      reasons: countReasons(skippedReasons.map((v) => v.reason)),
    },
    cannot: { total: p.cannot.length, reasons: countReasons(p.cannot.flatMap((c) => c.reasons)) },
    excludedAnnouncements: p.excludedAnnouncements,
    samples: await samples(p, ctx),
    runningJob: running ? await jobView(running.id) : null,
  };
}

// ───────── SA-7 / SA-8 confirm ─────────

const newId = (prefix: string) => `${prefix}${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** POST /api/messages/send-all — create the job and return at once (the worker sends). Idempotent per filter (SA-8). */
export async function startSendAll(actor: Actor, raw: unknown): Promise<SendAllStartResponse> {
  assertSendAll(actor);
  const input = sendAllSchema.parse(raw ?? {});
  const key = filterKeyOf(input.filter);
  const running = await prisma.bulkSendJob.findFirst({ where: { filterKey: key, status: { in: ["QUEUED", "RUNNING"] } } });
  if (running) return { job: await jobView(running.id), created: false };
  const ctx = await newCtx();
  const p = await plan(actor, input, ctx);
  const jobId = newId("bsj_");
  const skippedCount = [...p.verdicts.values()].filter((v) => v.status !== "OK").length;
  const preflight = { skipped: skippedCount, cannot: p.cannot.length, excludedAnnouncements: p.excludedAnnouncements, willSend: p.items.length };
  const created = await withTx(async (tx) => {
    const now = clock.now();
    const ins = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO bulk_send_jobs (id, filter_key, filter, use_other_channels, whatsapp_api, announcements, status, total, preflight, created_by, finished_at, created_at, updated_at)
      VALUES (${jobId}, ${key}, ${input.filter}, ${input.useOtherChannels}, ${p.whatsappOn}, ${can(actor, "messages.announce")},
              ${p.items.length ? "QUEUED" : "DONE"}, ${p.items.length}, ${JSON.stringify(preflight)}::jsonb, ${actorId(actor)}, ${p.items.length ? null : now}, ${now}, ${now})
      ON CONFLICT (filter_key) WHERE status IN ('QUEUED', 'RUNNING') DO NOTHING
      RETURNING id`;
    if (!ins.length) return false;
    if (p.items.length) {
      await tx.bulkSendJobItem.createMany({
        data: p.items.map((it, i) => ({ id: `bsi_${jobId.slice(4)}_${String(i).padStart(5, "0")}`, jobId, taskId: it.task.id, channels: it.channels, createdAt: now, updatedAt: now })),
      });
    }
    // The stale, duplicate and expired tasks leave the queue now (SA-1/SA-2/SA-3), with their reason.
    await applyVerdicts(tx, actor, p.verdicts, { jobId });
    await audit(tx, actor, "message.send_all", "bulk_send_job", jobId, {
      after: { filter: input.filter, useOtherChannels: input.useOtherChannels, whatsappApi: p.whatsappOn, ...preflight },
    });
    return true;
  });
  if (!created) {
    // SA-8: another click won the race — show its job.
    const other = await prisma.bulkSendJob.findFirst({ where: { filterKey: key, status: { in: ["QUEUED", "RUNNING"] } } });
    if (other) return { job: await jobView(other.id), created: false };
    throw new DomainError("ORDER_STATE_INVALID", "Send all could not start — try again.");
  }
  return { job: await jobView(jobId), created: true };
}

// ───────── the worker ─────────

type RunOpts = {
  /** Stop after this long (ms of the app clock). */
  budgetMs?: number;
  /** At most this many items in this run. */
  maxItems?: number;
  /** Wait (tests pass one that moves the pinned clock). */
  sleep?: (ms: number) => Promise<void>;
};
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Worker job (every minute, ~50 s; also right after a confirm): send the items of every QUEUED / RUNNING job, check
 * on the ones waiting (WhatsApp retries, a rate-limit pause, pushes held for the quiet hours) and finish jobs that are
 * done. Items are claimed with SKIP LOCKED, so two runs never send one task twice.
 */
export async function runSendAllJobs(opts: RunOpts = {}): Promise<{ sent: number; failed: number; skipped: number; waiting: number }> {
  const sleep = opts.sleep ?? realSleep;
  const budget = opts.budgetMs ?? 50_000;
  const max = opts.maxItems ?? Number.POSITIVE_INFINITY;
  const started = clock.now().getTime();
  const left = () => budget - (clock.now().getTime() - started);
  const result = { sent: 0, failed: 0, skipped: 0, waiting: 0 };
  const run = `run:${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const jobs = await prisma.bulkSendJob.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { createdAt: "asc" } });
  const ctx = await newCtx();
  let n = 0;
  for (const job of jobs) {
    if (job.status === "QUEUED") await prisma.bulkSendJob.updateMany({ where: { id: job.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: clock.now(), updatedAt: clock.now() } });
    await refreshWaiting(job.id);
    while (n < max && left() > 0) {
      const paused = !!(await channelPausedUntil("WHATSAPP_API"));
      const item = await claimItem(job.id, run, paused);
      if (!item) break;
      n++;
      const out = await sendItem(job, item, ctx, { sleep, left });
      result[out]++;
    }
    await refreshWaiting(job.id);
    await finishIfDone(job.id);
  }
  return result;
}

type Item = { id: string; job_id: string; task_id: string; channels: string[] };

async function claimItem(jobId: string, run: string, whatsappPaused: boolean): Promise<Item | null> {
  const now = clock.now();
  const rows = await prisma.$queryRaw<Item[]>`
    WITH next AS (
      SELECT id FROM bulk_send_job_items
       WHERE job_id = ${jobId} AND (status = 'PENDING' OR (status = 'SENDING' AND claimed_at < ${new Date(now.getTime() - STALE_MS)}))
         ${whatsappPaused ? Prisma.sql`AND NOT ('WHATSAPP_API' = ANY(channels))` : Prisma.empty}
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
    UPDATE bulk_send_job_items i SET status = 'SENDING', claimed_by = ${run}, claimed_at = ${now}, updated_at = ${now}
      FROM next WHERE i.id = next.id
    RETURNING i.id, i.job_id, i.task_id, i.channels`;
  return rows[0] ?? null;
}

async function setItem(id: string, status: "PENDING" | "WAITING" | "SENT" | "FAILED" | "SKIPPED", error: string | null = null) {
  await prisma.bulkSendJobItem.update({ where: { id }, data: { status, error: error?.slice(0, 500) ?? null, claimedBy: null, ...(status === "SENT" ? { sentAt: clock.now() } : {}), updatedAt: clock.now() } });
}

/** Release the task back to the queue with the reason it could not be sent (SA-7). */
async function releaseTask(taskId: string, reason: string) {
  await prisma.notificationDelivery.updateMany({
    where: { id: taskId, status: "QUEUED", handledBy: { startsWith: CLAIM } },
    data: { handledBy: null, error: `Send all: ${reason}`.slice(0, 500), updatedAt: clock.now() },
  });
}

async function markTaskSent(taskId: string, jobId: string) {
  await prisma.notificationDelivery.updateMany({
    where: { id: taskId, status: "QUEUED" },
    data: { status: "SENT_AUTOMATICALLY", sentAt: clock.now(), handledBy: `${CLAIM}${jobId}`, error: null, updatedAt: clock.now() },
  });
}

/** One delivery row for the task on a channel (rendered now — URL-3), linked to the task and the job. */
function deliveryRow(task: NotificationDelivery, jobId: string, createdBy: string | null, channel: Channel, extra: Partial<Prisma.NotificationDeliveryCreateManyInput>): Prisma.NotificationDeliveryCreateManyInput {
  const now = clock.now();
  const recipientKey = task.recipientKey ?? (task.memberId ? `member:${task.memberId}` : task.guestId ? `guest:${task.guestId}` : task.leadId ? `lead:${task.leadId}` : null);
  return {
    id: newId("nd_"), event: task.event, dedupeKey: `sendall:${jobId}:${task.id}${extra.pushSubscriptionId ? `:${extra.pushSubscriptionId}` : ""}`, channel, status: "QUEUED",
    userId: task.userId, guestId: task.guestId, memberId: task.memberId, leadId: task.leadId, title: task.title, body: task.body, link: task.link,
    triggeredBy: createdBy ?? "system", templateId: task.templateId, templateVersion: task.templateVersion, templateContext: task.templateContext,
    templateCategory: task.templateCategory, recordId: task.recordId, recipientKey, renderSpec: (task.renderSpec ?? undefined) as Prisma.InputJsonValue | undefined,
    contextIds: (task.contextIds ?? undefined) as Prisma.InputJsonValue | undefined, bulkJobId: jobId, taskId: task.id, createdAt: now, updatedAt: now,
    ...extra,
  };
}

type Outcome = "sent" | "failed" | "skipped" | "waiting";

async function sendItem(job: { id: string; useOtherChannels: boolean; createdBy: string | null }, item: Item, ctx: Ctx, t: { sleep: (ms: number) => Promise<void>; left: () => number }): Promise<Outcome> {
  const now = clock.now();
  // Hold the task: nobody opens it by hand while it is being sent (and two jobs never both send it).
  const held = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE notification_deliveries SET handled_by = ${CLAIM + job.id}, updated_at = ${now}
     WHERE id = ${item.task_id} AND channel = 'WHATSAPP_MANUAL' AND status = 'QUEUED'
       AND (handled_by IS NULL OR handled_by = ${CLAIM + job.id} OR (handled_by LIKE 'sendall:%' AND updated_at < ${new Date(now.getTime() - STALE_MS)}))
    RETURNING id`;
  const task = await prisma.notificationDelivery.findUnique({ where: { id: item.task_id } });
  if (!held.length || !task) {
    await setItem(item.id, "SKIPPED", task ? `Already ${task.status.toLowerCase().replace(/_/g, " ")}` : "The message is gone");
    return "skipped";
  }
  // SA-1 again at send time: the bill may have been paid since the confirm.
  const rel = await isStillRelevant(task);
  if (!rel.relevant) {
    await prisma.notificationDelivery.update({ where: { id: task.id }, data: { status: "SKIPPED_NOT_RELEVANT", error: rel.reason, handledBy: null, updatedAt: clock.now() } });
    await setItem(item.id, "SKIPPED", rel.reason);
    return "skipped";
  }
  const reach = await reachOf(task, ctx);
  let channels = item.channels as Channel[];
  if (channels.includes("WHATSAPP_API") && !reach.wa.ok) {
    // The API went off (or the template / consent changed) since the confirm: other channels if allowed.
    const r = routeOf(reach, job.useOtherChannels);
    if (r.kind !== "SEND") {
      const why = r.kind === "SKIP" ? r.reason : r.reasons.join(" · ");
      await releaseTask(task.id, why);
      await setItem(item.id, "FAILED", why);
      return "failed";
    }
    channels = r.channels;
  }
  const rendered = await renderDelivery(task, ctx.render);
  const ids: string[] = [];
  const errors: string[] = [];

  if (channels.includes("WHATSAPP_API") && reach.wa.ok) {
    const row = deliveryRow(task, job.id, job.createdBy, "WHATSAPP_API", {
      toAddress: reach.number, toMasked: maskPhone(reach.number), body: rendered.whatsappText, whatsappText: rendered.whatsappText,
      waTemplate: reach.wa.template, waLanguage: reach.wa.language, waParams: reach.wa.params, waButtonParam: reach.wa.buttonParam,
    });
    await prisma.notificationDelivery.create({ data: row });
    ids.push(row.id!);
    // SA-0: the official Cloud API sender (retries with backoff, rate-limit pause, never WhatsApp Web).
    await dispatchWhatsApp([row.id!]);
  }
  if (channels.includes("EMAIL") && reach.email.ok) {
    // ≤ 1 email per second across every worker (v5's shared rate gate).
    let wait = await takePermit();
    while (wait > 0) {
      if (t.left() - wait <= 0) {
        if (!ids.length) {
          await prisma.notificationDelivery.updateMany({ where: { id: task.id, handledBy: CLAIM + job.id, status: "QUEUED" }, data: { handledBy: null } });
          await setItem(item.id, "PENDING");
          return "waiting";
        }
        break;
      }
      await t.sleep(wait);
      wait = await takePermit();
    }
    if (wait <= 0) {
      const r = await renderDelivery({ ...task, channel: "EMAIL" }, ctx.render);
      const row = deliveryRow(task, job.id, job.createdBy, "EMAIL", { toAddress: reach.email.to, toMasked: maskEmail(reach.email.to), title: r.title, body: r.body, link: r.link, handledBy: `${CLAIM}${job.id}` });
      const created = await prisma.notificationDelivery.create({ data: row });
      ids.push(created.id);
      if ((await deliverRow(created, ctx.caps)) === "FAILED") errors.push(`Email: ${(await prisma.notificationDelivery.findUnique({ where: { id: created.id }, select: { error: true } }))?.error ?? "failed"}`);
    }
  }
  if (channels.includes("PUSH") && reach.push.ok) {
    const r = await renderDelivery({ ...task, channel: "PUSH" }, ctx.render);
    // NT-7: a push waits out the quiet hours (22:00–07:00 IST); the messages worker sends it at 07:00.
    const hold = inQuietHours(clock.now()) ? quietHoursEnd(clock.now()) : null;
    for (const d of reach.push.devices) {
      const row = deliveryRow(task, job.id, job.createdBy, "PUSH", {
        pushSubscriptionId: d.id, toAddress: "device", toMasked: "device", title: r.title, body: r.body, link: task.link,
        notBefore: hold, handledBy: hold ? QUEUE_MARK : `${CLAIM}${job.id}`,
      });
      const created = await prisma.notificationDelivery.create({ data: row });
      ids.push(created.id);
      if (!hold && (await deliverRow(created, ctx.caps)) === "FAILED") errors.push(`Push: ${(await prisma.notificationDelivery.findUnique({ where: { id: created.id }, select: { error: true } }))?.error ?? "failed"}`);
    }
  }
  return settleItem(job.id, item.id, task.id, errors);
}

/** Look at the item's delivery rows: any sent → SENT_AUTOMATICALLY; some still queued → WAITING; else FAILED. */
async function settleItem(jobId: string, itemId: string, taskId: string, errors: string[] = []): Promise<Outcome> {
  const rows = await prisma.notificationDelivery.findMany({ where: { taskId, bulkJobId: jobId }, select: { status: true, channel: true, error: true } });
  if (rows.some((r) => r.status === "SENT" || r.status === "DELIVERED")) {
    await markTaskSent(taskId, jobId);
    await setItem(itemId, "SENT");
    return "sent";
  }
  if (rows.some((r) => r.status === "QUEUED")) {
    await setItem(itemId, "WAITING");
    return "waiting";
  }
  const why = [...errors, ...rows.filter((r) => r.status === "FAILED" && r.error).map((r) => `${r.channel === "WHATSAPP_API" ? "WhatsApp" : r.channel === "EMAIL" ? "Email" : "Push"}: ${r.error}`)];
  const reason = [...new Set(why)].join(" · ") || "Nothing could be sent";
  await releaseTask(taskId, reason);
  await setItem(itemId, "FAILED", reason);
  return "failed";
}

/** WAITING items: send WhatsApp rows that are due again (after a backoff or the rate-limit pause), then settle. */
async function refreshWaiting(jobId: string) {
  const waiting = await prisma.bulkSendJobItem.findMany({ where: { jobId, status: "WAITING" }, select: { id: true, taskId: true } });
  if (!waiting.length) return;
  if (!(await channelPausedUntil("WHATSAPP_API"))) {
    const due = await prisma.notificationDelivery.findMany({
      where: { bulkJobId: jobId, channel: "WHATSAPP_API", status: "QUEUED", handledBy: null, OR: [{ notBefore: null }, { notBefore: { lte: clock.now() } }] },
      select: { id: true },
    });
    if (due.length) await dispatchWhatsApp(due.map((d) => d.id));
  }
  for (const w of waiting) await settleItem(jobId, w.id, w.taskId);
}

async function finishIfDone(jobId: string) {
  const open = await prisma.bulkSendJobItem.count({ where: { jobId, status: { in: ["PENDING", "SENDING", "WAITING"] } } });
  if (open) return;
  const done = await prisma.bulkSendJob.updateMany({ where: { id: jobId, status: { not: "DONE" } }, data: { status: "DONE", finishedAt: clock.now(), updatedAt: clock.now() } });
  if (done.count) {
    const counts = await prisma.bulkSendJobItem.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } });
    await audit(prisma as unknown as Tx, SYSTEM, "message.send_all_done", "bulk_send_job", jobId, { after: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) });
  }
}

// ───────── progress and summary ─────────

/** GET /api/messages/send-all/[id] — live progress (sent / failed / remaining) and the summary when done. */
export async function sendAllProgress(actor: Actor, id: string): Promise<SendAllJob> {
  assertSendAll(actor);
  return jobView(id);
}

/** GET /api/messages/send-all — the running job for this filter, else the latest job (or null). */
export async function currentSendAll(actor: Actor, filter: string): Promise<SendAllJob | null> {
  assertSendAll(actor);
  const key = filterKeyOf(filter);
  const j = (await prisma.bulkSendJob.findFirst({ where: { filterKey: key, status: { in: ["QUEUED", "RUNNING"] } } }))
    ?? (await prisma.bulkSendJob.findFirst({ where: { filterKey: key }, orderBy: { createdAt: "desc" } }));
  return j ? jobView(j.id) : null;
}

async function jobView(id: string): Promise<SendAllJob> {
  const j = await prisma.bulkSendJob.findUnique({ where: { id } });
  if (!j) throw new DomainError("NOT_FOUND", "Send-all job was not found.");
  const [items, perRows, creator, failed] = await Promise.all([
    prisma.bulkSendJobItem.groupBy({ by: ["status"], where: { jobId: id }, _count: { _all: true } }),
    prisma.notificationDelivery.groupBy({ by: ["channel", "status"], where: { bulkJobId: id }, _count: { _all: true } }),
    j.createdBy ? prisma.user.findUnique({ where: { id: j.createdBy }, select: { name: true } }) : null,
    prisma.bulkSendJobItem.findMany({ where: { jobId: id, status: "FAILED" }, orderBy: { id: "asc" }, take: 50, select: { taskId: true, error: true } }),
  ]);
  const c = (s: string) => items.find((x) => x.status === s)?._count._all ?? 0;
  const perChannel: SendAllJob["perChannel"] = {};
  for (const r of perRows) {
    const ch = r.channel as "WHATSAPP_API" | "EMAIL" | "PUSH";
    const x = (perChannel[ch] ??= { sent: 0, failed: 0, queued: 0 });
    if (r.status === "SENT" || r.status === "DELIVERED") x.sent += r._count._all;
    else if (r.status === "FAILED") x.failed += r._count._all;
    else if (r.status === "QUEUED") x.queued += r._count._all;
  }
  const tasks = failed.length ? await prisma.notificationDelivery.findMany({ where: { id: { in: failed.map((f) => f.taskId) } }, select: { id: true, title: true, userId: true, guestId: true } }) : [];
  const names = new Map<string, string>();
  for (const u of await prisma.user.findMany({ where: { id: { in: tasks.map((t) => t.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })) names.set(u.id, u.name);
  for (const g of await prisma.guest.findMany({ where: { id: { in: tasks.map((t) => t.guestId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })) names.set(g.id, g.name);
  const pending = c("PENDING") + c("SENDING") + c("WAITING");
  const paused = pending ? await channelPausedUntil("WHATSAPP_API") : null;
  const pre = (j.preflight ?? {}) as { skipped?: number; cannot?: number; excludedAnnouncements?: number };
  return {
    id: j.id, status: j.status as SendAllJob["status"], filter: j.filter, useOtherChannels: j.useOtherChannels, whatsappApi: j.whatsappApi,
    createdAt: j.createdAt.toISOString(), createdBy: creator?.name ?? null, startedAt: j.startedAt?.toISOString() ?? null, finishedAt: j.finishedAt?.toISOString() ?? null,
    total: j.total, sent: c("SENT"), failed: c("FAILED"), skipped: c("SKIPPED"), remaining: pending, waiting: c("WAITING"),
    pausedUntil: paused?.toISOString() ?? null, perChannel,
    failures: failed.map((f) => {
      const t = tasks.find((x) => x.id === f.taskId);
      return { taskId: f.taskId, name: (t && (names.get(t.userId ?? "") ?? names.get(t.guestId ?? ""))) ?? t?.title ?? "", reason: f.error ?? "" };
    }),
    preflight: { skipped: pre.skipped ?? 0, cannot: pre.cannot ?? 0, excludedAnnouncements: pre.excludedAnnouncements ?? 0 },
  };
}
