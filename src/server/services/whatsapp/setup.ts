// v4 §5.1 Settings → WhatsApp (Owner): connection status, template mapping, "Fetch templates" from Meta and the test
// message that switches the `whatsapp.api` capability on. Values of env variables never leave the server: the page
// sees only whether each one is set.
import { z } from "zod";
import { clock } from "@/lib/clock";
import { withTx } from "../../db";
import { DomainError } from "../../errors";
import type { Actor } from "../../rbac/actor";
import { assertCan } from "../../rbac/permissions";
import { audit } from "../audit";
import { getCapabilities, invalidateCapabilities } from "../capabilities";
import { getSettings, writeSettingTx, type StoredSettings } from "../settings";
import { graphBase, graphFetch, sendTemplateMessage, classifyWhatsAppError } from "./client";
import { toWhatsAppNumber, WHATSAPP_ENV, writeHealth } from "./config";
import { WA_TEMPLATE_NAMES, WA_TEMPLATES, type WaTemplateName } from "./templates";

type TemplateMap = StoredSettings["whatsapp_template_map"];

/** Meta's template statuses we show (anything else is shown as Meta wrote it). */
export const META_TEMPLATE_STATUSES = ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL", "PENDING_DELETION", "DELETED", "LIMIT_EXCEEDED"] as const;

const appUrl = () => (process.env.APP_URL ?? "").replace(/\/$/, "");

/** Everything the Settings page shows. */
export async function whatsappSetupStatus(actor: Actor) {
  assertCan(actor, "settings");
  invalidateCapabilities();
  const [s, caps] = await Promise.all([getSettings(), getCapabilities()]);
  const env = WHATSAPP_ENV.map((name) => ({ name, set: !!(process.env[name] ?? "").trim() }));
  const map = s.whatsapp_template_map;
  return {
    capability: caps["whatsapp.api"],
    env,
    envOk: env.every((e) => e.set),
    token: { ok: s.whatsapp_health.token_ok, checkedAt: s.whatsapp_health.token_checked_at, reason: s.whatsapp_health.token_reason, phone: s.whatsapp_health.phone_display },
    webhook: { url: appUrl() ? `${appUrl()}/api/whatsapp/webhook` : null, verifiedAt: s.whatsapp_health.webhook_verified_at },
    testSentAt: s.whatsapp_verified_at,
    buttonBase: appUrl() ? `${appUrl()}/` : null,
    templates: WA_TEMPLATE_NAMES.map((key) => ({
      key,
      required: WA_TEMPLATES[key].required,
      variables: WA_TEMPLATES[key].vars.length,
      button: WA_TEMPLATES[key].button,
      name: map[key]?.name ?? null,
      language: map[key]?.language ?? null,
      status: map[key]?.status ?? null,
      checkedAt: map[key]?.checked_at ?? null,
    })),
  };
}

function requireEnv(names: ReadonlyArray<(typeof WHATSAPP_ENV)[number]>) {
  const missing = names.filter((k) => !(process.env[k] ?? "").trim());
  if (missing.length) throw new DomainError("CAPABILITY_DISABLED", `WhatsApp is not configured on the server: ${missing.join(", ")} not set in .env.`);
}

async function graphGet(path: string): Promise<{ reached: true; status: number; json: Record<string, unknown> } | { reached: false; error: string }> {
  try {
    const res = await graphFetch()(path.startsWith("https://") ? path : `${graphBase()}/${path}`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN!.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    return { reached: true, status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (e) {
    return { reached: false, error: e instanceof Error ? e.message.slice(0, 200) : "network error" };
  }
}

/** WA-16: "Check access token": ask Meta for the club's phone number with the token. */
export async function checkWhatsappToken(actor: Actor) {
  assertCan(actor, "settings");
  requireEnv(["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_API_VERSION"]);
  const r = await graphGet(`${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID!.trim())}?fields=display_phone_number,verified_name`);
  if (!r.reached) throw new DomainError("VALIDATION_FAILED", `Could not reach Meta: ${r.error}. Nothing was changed; try again.`);
  const now = clock.now().toISOString();
  if (r.status >= 200 && r.status < 300) {
    const phone = [r.json.verified_name, r.json.display_phone_number].filter(Boolean).join(" · ") || null;
    await withTx(async (tx) => {
      await writeHealth({ token_ok: true, token_checked_at: now, token_reason: null, phone_display: phone ? String(phone).slice(0, 60) : null }, tx);
      await audit(tx, actor, "whatsapp.token_check", "setting", "whatsapp_health", { after: { ok: true } });
    });
    return { ok: true as const, phone };
  }
  const c = classifyWhatsAppError(r.status, r.json.error as Parameters<typeof classifyWhatsAppError>[1]);
  if (c.kind === "RETRY" || c.kind === "RATE_LIMITED") throw new DomainError("VALIDATION_FAILED", `Meta could not answer now (${c.reason}). Nothing was changed; try again.`);
  await withTx(async (tx) => {
    await writeHealth({ token_ok: false, token_checked_at: now, token_reason: c.reason }, tx);
    await audit(tx, actor, "whatsapp.token_check", "setting", "whatsapp_health", { after: { ok: false, reason: c.reason } });
  });
  return { ok: false as const, reason: c.reason };
}

const mappingEntry = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "Template names use lowercase letters, digits and _").or(z.literal("")),
  language: z.string().trim().regex(/^[A-Za-z]{2,3}(_[A-Za-z]{2,4})?$/, "Language code like en or en_US"),
});
export const templateMappingSchema = z.object({ templates: z.partialRecord(z.enum(WA_TEMPLATE_NAMES), mappingEntry) });

/** WA-17: save the mapping (template name + language per event). An unchanged entry keeps Meta's status. */
export async function saveTemplateMapping(actor: Actor, raw: z.input<typeof templateMappingSchema>) {
  assertCan(actor, "settings");
  const input = templateMappingSchema.parse(raw);
  return withTx(async (tx) => {
    const cur = (await getSettings(tx)).whatsapp_template_map;
    const next: TemplateMap = { ...cur };
    for (const [key, v] of Object.entries(input.templates) as Array<[WaTemplateName, z.infer<typeof mappingEntry>]>) {
      if (!v.name) {
        delete next[key];
        continue;
      }
      const same = cur[key]?.name === v.name && cur[key]?.language === v.language;
      next[key] = { name: v.name, language: v.language, status: same ? cur[key]!.status : null, checked_at: same ? cur[key]!.checked_at : null };
    }
    await writeSettingTx(tx, actor, "whatsapp_template_map", next);
    return next;
  });
}

type MetaTemplate = { name?: string; language?: string; status?: string; category?: string };

/**
 * WA-18: "Fetch templates" — `GET /{WABA_ID}/message_templates` (all pages). Each mapped template gets Meta's status
 * (APPROVED / PENDING / REJECTED / PAUSED …, or NOT_FOUND when no template has that name + language), stored with the
 * mapping. Returns the club's templates as Meta lists them too, so the Owner can see what exists.
 */
export async function fetchWhatsappTemplates(actor: Actor) {
  assertCan(actor, "settings");
  requireEnv(["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_GRAPH_API_VERSION"]);
  const all: MetaTemplate[] = [];
  let url: string | null = `${encodeURIComponent(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID!.trim())}/message_templates?fields=name,language,status,category&limit=200`;
  for (let page = 0; url && page < 20; page++) {
    const r = await graphGet(url);
    if (!r.reached) throw new DomainError("VALIDATION_FAILED", `Could not reach Meta: ${r.error}. Try again.`);
    if (r.status < 200 || r.status >= 300) {
      const c = classifyWhatsAppError(r.status, r.json.error as Parameters<typeof classifyWhatsAppError>[1]);
      throw new DomainError("VALIDATION_FAILED", `Meta did not return the templates: ${c.reason}`);
    }
    all.push(...(((r.json.data as MetaTemplate[] | undefined) ?? []).filter((t) => t && typeof t.name === "string")));
    const next = (r.json.paging as { next?: string } | undefined)?.next;
    url = next && next.startsWith("https://graph.facebook.com/") ? next : null;
  }
  const now = clock.now().toISOString();
  const updated = await withTx(async (tx) => {
    const cur = (await getSettings(tx)).whatsapp_template_map;
    const next: TemplateMap = { ...cur };
    for (const key of Object.keys(cur) as WaTemplateName[]) {
      const m = cur[key]!;
      const found = all.find((t) => t.name === m.name && (t.language ?? "").toLowerCase() === m.language.toLowerCase());
      next[key] = { ...m, status: found?.status ? String(found.status).toUpperCase().slice(0, 30) : "NOT_FOUND", checked_at: now };
    }
    await writeSettingTx(tx, actor, "whatsapp_template_map", next);
    return next;
  });
  return {
    mapped: updated,
    meta: all.map((t) => ({ name: t.name!, language: t.language ?? "", status: t.status ?? "", category: t.category ?? "" })).slice(0, 500),
  };
}

export const whatsappTestMessageSchema = z.object({
  to: z.string().trim().min(10).max(20),
  template: z.string().trim().regex(/^[a-z0-9_]{1,512}$/).default("hello_world"),
  language: z.string().trim().regex(/^[A-Za-z]{2,3}(_[A-Za-z]{2,4})?$/).default("en_US"),
});

/**
 * WA-19: "Send test message" — one template message (default Meta's `hello_world`, which has no variables) to a phone.
 * Success records the time (capability input) and proves the token; failure says why and switches nothing on.
 */
export async function sendWhatsappTestMessage(actor: Actor, raw: z.input<typeof whatsappTestMessageSchema>) {
  assertCan(actor, "settings");
  const input = whatsappTestMessageSchema.parse(raw);
  requireEnv(WHATSAPP_ENV);
  const to = toWhatsAppNumber(input.to);
  if (!to) throw new DomainError("VALIDATION_FAILED", "Enter a 10-digit Indian mobile number.");
  const r = await sendTemplateMessage({ to, template: input.template, language: input.language, params: [], buttonParam: null });
  if (!r.ok) {
    await withTx((tx) => audit(tx, actor, "whatsapp.test_message", "setting", "whatsapp_verified_at", { after: { ok: false, to: `******${to.slice(-4)}`, reason: r.reason } }));
    throw new DomainError("VALIDATION_FAILED", `The test message was not sent: ${r.reason}`);
  }
  const now = clock.now().toISOString();
  await withTx(async (tx) => {
    await writeSettingTx(tx, actor, "whatsapp_verified_at", now);
    // Meta accepted a message with this token: the token works.
    const h = (await getSettings(tx)).whatsapp_health;
    if (h.token_ok !== true) await writeHealth({ token_ok: true, token_checked_at: now, token_reason: null }, tx);
    await audit(tx, actor, "whatsapp.test_message", "setting", "whatsapp_verified_at", { after: { ok: true, to: `******${to.slice(-4)}`, wamid: r.wamid } });
  });
  invalidateCapabilities();
  return { ok: true as const, to, wamid: r.wamid };
}
