// v4 §5.2 / §5.4 step 3 (WHATSAPP): template builders and value sanitising, the Cloud API request and how its errors
// are classified. Outbound HTTP to Meta is mocked; nothing here needs the database.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyWhatsAppError, sendTemplateMessage, setWhatsAppFetchForTests, templateRequestBody } from "@/server/services/whatsapp/client";
import { toWhatsAppNumber } from "@/server/services/whatsapp/config";
import {
  buildTemplate, sanitizeTemplateValue, WA_TEMPLATE_NAMES, WA_TEMPLATES, WA_VALUE_MAX, waAmount, waDate, waDateTime, waFirstName, waSession, waTime, type WaMessage,
} from "@/server/services/whatsapp/templates";

describe("WA-10 — template values are sanitised (§5.2)", () => {
  it("newlines and tabs become one space, more than 4 spaces collapse, ends are trimmed", () => {
    expect(sanitizeTemplateValue("Wet\ncourt")).toBe("Wet court");
    expect(sanitizeTemplateValue("a\r\n\tb")).toBe("a b");
    expect(sanitizeTemplateValue("a\t\tb")).toBe("a b");
    expect(sanitizeTemplateValue("a     b")).toBe("a b"); // 5 spaces
    expect(sanitizeTemplateValue("a    b")).toBe("a    b"); // 4 spaces are allowed
    expect(sanitizeTemplateValue("  padded  ")).toBe("padded");
    expect(sanitizeTemplateValue(550)).toBe("550");
    for (const v of ["x\ny", "x\ty", "x      y", "\n\n\n"]) {
      const s = sanitizeTemplateValue(v);
      expect(s).not.toMatch(/[\n\t]/);
      expect(s).not.toMatch(/ {5,}/);
    }
  });

  it("caps every value at 60 characters", () => {
    const long = "The court surface is being relaid after the monsoon damage near the net posts";
    const s = sanitizeTemplateValue(long);
    expect(s.length).toBeLessThanOrEqual(WA_VALUE_MAX);
    expect(WA_VALUE_MAX).toBe(60);
    expect(s.endsWith("…")).toBe(true);
    expect(long.startsWith(s.slice(0, -1))).toBe(true);
    expect(sanitizeTemplateValue("x".repeat(60))).toBe("x".repeat(60));
  });
});

/** One sample message per template, values given out of order on purpose (the builder puts them in {{n}} order). */
const SAMPLES: Record<string, { m: WaMessage; params: string[]; button: string | null }> = {
  club_session_cancelled: {
    m: { template: "club_session_cancelled", vars: { deadline: "Sat, 17 Oct, 6:00 pm", amount: "800", reason: "Wet court", time: "6:00 pm", date: "Sat, 10 Oct 2026", session: "Tennis (Court 2)", name: "Asha" }, button: { token: "R1.ck1.abc.sig_-" } },
    params: ["Asha", "Tennis (Court 2)", "Sat, 10 Oct 2026", "6:00 pm", "Wet court", "800", "Sat, 17 Oct, 6:00 pm"], button: "R1.ck1.abc.sig_-",
  },
  booking_cancelled_refund: {
    m: { template: "booking_cancelled_refund", vars: { refund: "₹800 to collect at the front desk", time: "6:00 pm", date: "Sat, 10 Oct 2026", booking: "BK-000123", name: "Asha" }, button: { ref: "RF-000045" } },
    params: ["Asha", "BK-000123", "Sat, 10 Oct 2026", "6:00 pm", "₹800 to collect at the front desk"], button: "RF-000045",
  },
  booking_rescheduled: {
    m: { template: "booking_rescheduled", vars: { booking: "BK-000130", date: "Mon, 12 Oct 2026", time: "7:00 pm", court: "Court 3", name: "Asha" }, button: { booking: "BK-000130" } },
    params: ["Asha", "Court 3", "7:00 pm", "Mon, 12 Oct 2026", "BK-000130"], button: "BK-000130",
  },
  cancellation_choice_reminder: {
    m: { template: "cancellation_choice_reminder", vars: { amount: "800", deadline: "Sat, 17 Oct, 6:00 pm", date: "Sat, 10 Oct 2026", name: "Asha" }, button: { token: "R1.ck1.abc.sig" } },
    params: ["Asha", "Sat, 10 Oct 2026", "Sat, 17 Oct, 6:00 pm", "800"], button: "R1.ck1.abc.sig",
  },
  refund_ready_to_collect: {
    m: { template: "refund_ready_to_collect", vars: { ref: "RF-000045", amount: "550", name: "Asha" }, button: { token: "RF1.ck2.sig" } },
    params: ["Asha", "550", "RF-000045"], button: "RF1.ck2.sig",
  },
  refund_completed: {
    m: { template: "refund_completed", vars: { ref: "RF-000045", date: "Sun, 11 Oct 2026", amount: "550", name: "Asha" } },
    params: ["Asha", "550", "Sun, 11 Oct 2026", "RF-000045"], button: null,
  },
  refund_rejected: {
    m: { template: "refund_rejected", vars: { reason: "Already played", amount: "300", ref: "RF-000046", name: "Asha" } },
    params: ["Asha", "RF-000046", "300", "Already played"], button: null,
  },
  refund_unclaimed_reminder: {
    m: { template: "refund_unclaimed_reminder", vars: { ref: "RF-000045", amount: "550", name: "Asha" }, button: { token: "RF1.ck2.sig" } },
    params: ["Asha", "550", "RF-000045"], button: "RF1.ck2.sig",
  },
  membership_welcome: {
    m: { template: "membership_welcome", vars: { end: "Sat, 2 Jan 2027", memberCode: "CC-000210", plan: "Gold", name: "Asha" } },
    params: ["Asha", "Gold", "CC-000210", "Sat, 2 Jan 2027"], button: null,
  },
  membership_expiring: {
    m: { template: "membership_expiring", vars: { end: "Sat, 10 Oct 2026", plan: "Silver", name: "Asha" } },
    params: ["Asha", "Silver", "Sat, 10 Oct 2026"], button: null,
  },
  dues_reminder: {
    m: { template: "dues_reminder", vars: { whatFor: "Court booking BK-000123", amount: "1,200", name: "Asha" } },
    params: ["Asha", "1,200", "Court booking BK-000123"], button: null,
  },
};

describe("WA-10 — one typed builder per template (§5.2)", () => {
  it("covers every template: required ones for cancellations, reschedules and refunds; welcome, expiring and dues optional", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...WA_TEMPLATE_NAMES].sort());
    expect(WA_TEMPLATE_NAMES.filter((n) => WA_TEMPLATES[n].required).sort()).toEqual([
      "booking_cancelled_refund", "booking_rescheduled", "cancellation_choice_reminder", "club_session_cancelled",
      "refund_completed", "refund_ready_to_collect", "refund_rejected", "refund_unclaimed_reminder",
    ]);
    expect(WA_TEMPLATE_NAMES.filter((n) => !WA_TEMPLATES[n].required).sort()).toEqual(["dues_reminder", "membership_expiring", "membership_welcome"]);
  });

  for (const name of WA_TEMPLATE_NAMES) {
    it(`${name}: body parameters in {{n}} order and the URL button suffix`, () => {
      const s = SAMPLES[name];
      const built = buildTemplate(s.m);
      expect(built.template).toBe(name);
      expect(built.params).toEqual(s.params);
      expect(built.params).toHaveLength(WA_TEMPLATES[name].vars.length);
      expect(built.buttonParam).toBe(s.button);
      expect(WA_TEMPLATES[name].button === null).toBe(s.button === null);
    });
  }

  it("sanitises every value it builds and keeps the button value URL-safe", () => {
    const built = buildTemplate({
      template: "club_session_cancelled",
      vars: { name: "Asha\nRao", session: "Tennis\t(Court 2)", date: "Sat,      10 Oct", time: "6:00 pm", reason: "x".repeat(80), amount: 800, deadline: "Sat" },
      button: { token: "a b/c?d" },
    });
    expect(built.params[0]).toBe("Asha Rao");
    expect(built.params[1]).toBe("Tennis (Court 2)");
    expect(built.params[2]).toBe("Sat, 10 Oct");
    expect(built.params[4].length).toBeLessThanOrEqual(60);
    expect(built.params[5]).toBe("800");
    expect(built.buttonParam).toBe("a%20b%2Fc%3Fd");
  });

  it("formats dates, times and amounts for India (no ₹ in amounts)", () => {
    const at = new Date("2026-10-10T12:30:00Z"); // 18:00 IST
    expect(waDate(at)).toBe("Sat, 10 Oct 2026");
    expect(waTime(at)).toBe("6:00 pm");
    expect(waDateTime(at)).toBe("Sat, 10 Oct, 6:00 pm");
    expect(waTime(new Date("2026-10-10T04:00:00Z"))).toBe("9:30 am");
    expect(waAmount(55_000)).toBe("550");
    expect(waAmount(155_000)).toBe("1,550");
    expect(waAmount(1_234_550)).toBe("12,345.50");
    expect(waAmount(55_000)).not.toContain("₹");
    expect(waFirstName("  Asha  Rao ")).toBe("Asha");
    expect(waFirstName("")).toBe("there");
    expect(waSession("TENNIS", "Court 2")).toBe("Tennis (Court 2)");
  });
});

// ───────── client ─────────
type Call = { url: string; init: RequestInit };
const ENV = { WHATSAPP_ACCESS_TOKEN: "test-token-secret-123", WHATSAPP_PHONE_NUMBER_ID: "1098765", WHATSAPP_GRAPH_API_VERSION: "v23.0" };
let saved: Record<string, string | undefined> = {};
let calls: Call[] = [];
function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  setWhatsAppFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }) as typeof fetch);
}
const metaError = (code: number, status = 400, extra: Record<string, unknown> = {}) => ({ status, body: { error: { message: `(#${code}) error`, type: "OAuthException", code, error_data: { messaging_product: "whatsapp", details: "details here" }, ...extra } } });

beforeEach(() => {
  calls = [];
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
});
afterEach(() => {
  setWhatsAppFetchForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const input = { to: "919876543210", template: "club_session_cancelled", language: "en", params: ["Asha", "Tennis (Court 2)"], buttonParam: "R1.ck1.abc.sig" };

describe("WA-11 — the Cloud API request (§5.4 step 3)", () => {
  it("POSTs a template message to /<version>/<PHONE_NUMBER_ID>/messages with the Bearer token and returns the wamid", async () => {
    mockFetch(200, { messaging_product: "whatsapp", contacts: [{ input: "919876543210", wa_id: "919876543210" }], messages: [{ id: "wamid.HBgM123" }] });
    const r = await sendTemplateMessage(input);
    expect(r).toEqual({ ok: true, wamid: "wamid.HBgM123" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.facebook.com/v23.0/1098765/messages");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-token-secret-123");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "template",
      template: {
        name: "club_session_cancelled",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "Tennis (Court 2)" }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "R1.ck1.abc.sig" }] },
        ],
      },
    });
  });

  it("a template without variables or button sends no components", () => {
    expect(templateRequestBody({ to: "919876543210", template: "hello_world", language: "en_US", params: [], buttonParam: null }).template).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });

  it("the version comes only from env (no hard-coded default); missing config is PERMANENT without a request", async () => {
    mockFetch(200, { messages: [{ id: "wamid.x" }] });
    process.env.WHATSAPP_GRAPH_API_VERSION = "24.0";
    await sendTemplateMessage(input);
    expect(calls[0].url).toBe("https://graph.facebook.com/v24.0/1098765/messages");
    delete process.env.WHATSAPP_GRAPH_API_VERSION;
    const r = await sendTemplateMessage(input);
    expect(r).toMatchObject({ ok: false, kind: "PERMANENT", reason: expect.stringContaining("WHATSAPP_GRAPH_API_VERSION") });
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    expect(await sendTemplateMessage(input)).toMatchObject({ ok: false, kind: "PERMANENT", reason: expect.stringContaining("WHATSAPP_ACCESS_TOKEN") });
    expect(calls).toHaveLength(1);
  });

  it("WA-13: the number must be 91XXXXXXXXXX (Indian mobile); anything else is PERMANENT and never sent", async () => {
    mockFetch(200, { messages: [{ id: "wamid.x" }] });
    for (const to of ["9876543210", "+919876543210", "91987654321", "915876543210", "14155550100", ""]) {
      expect(await sendTemplateMessage({ ...input, to })).toMatchObject({ ok: false, kind: "PERMANENT" });
    }
    expect(calls).toHaveLength(0);
    expect(toWhatsAppNumber("+91 98765 43210")).toBe("919876543210");
    expect(toWhatsAppNumber("098765-43210")).toBe("919876543210");
    expect(toWhatsAppNumber("9876543210")).toBe("919876543210");
    expect(toWhatsAppNumber("5876543210")).toBeNull();
    expect(toWhatsAppNumber("12345")).toBeNull();
  });

  it("never puts the access token in a result or reason", async () => {
    mockFetch(400, { error: { message: "Invalid token test-token-secret-123", code: 100 } });
    const r = await sendTemplateMessage(input);
    expect(JSON.stringify(r)).not.toContain("test-token-secret-123");
  });
});

describe("WA-12 — error classification", () => {
  it("network errors, timeouts and 5xx → RETRY", async () => {
    setWhatsAppFetchForTests((async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    expect(await sendTemplateMessage(input)).toMatchObject({ ok: false, kind: "RETRY" });
    setWhatsAppFetchForTests((async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }) as typeof fetch);
    expect(await sendTemplateMessage(input)).toMatchObject({ ok: false, kind: "RETRY", reason: expect.stringContaining("in time") });
    mockFetch(500, { error: { message: "Internal error" } });
    expect(await sendTemplateMessage(input)).toMatchObject({ ok: false, kind: "RETRY" });
    mockFetch(503, {});
    expect(await sendTemplateMessage(input)).toMatchObject({ ok: false, kind: "RETRY" });
    // Meta's own "temporary" codes
    for (const code of [1, 2, 131000, 131016]) expect(classifyWhatsAppError(400, { code })).toMatchObject({ kind: "RETRY" });
    // A 200 without a message id is not a success.
    mockFetch(200, { messages: [] });
    expect(await sendTemplateMessage(input)).toMatchObject({ ok: false, kind: "RETRY" });
  });

  it("HTTP 429 and Meta's throughput / pair / account rate limits → RATE_LIMITED with a pause", async () => {
    mockFetch(429, { error: { message: "Too many", code: 130429 } }, { "Retry-After": "120" });
    expect(await sendTemplateMessage(input)).toEqual({ ok: false, kind: "RATE_LIMITED", reason: expect.any(String), pauseMs: 120_000 });
    for (const code of [130429, 131056, 80007, 131048, 4]) {
      const r = classifyWhatsAppError(400, { code });
      expect(r.kind).toBe("RATE_LIMITED");
      expect(r.kind === "RATE_LIMITED" && r.pauseMs).toBeGreaterThan(0);
    }
    expect(classifyWhatsAppError(429, undefined)).toMatchObject({ kind: "RATE_LIMITED", pauseMs: 60_000 });
  });

  it("invalid number / not on WhatsApp / template missing, not approved or paused / parameter mismatch / policy → PERMANENT with the code", async () => {
    for (const code of [131026, 132000, 132001, 132015, 132016, 131051, 368, 100, 131008, 131009, 132012, 131047, 133010]) {
      const e = metaError(code);
      mockFetch(e.status, e.body);
      const r = await sendTemplateMessage(input);
      expect(r).toMatchObject({ ok: false, kind: "PERMANENT", code });
      expect(r.ok === false && r.reason).toContain(`#${code}`);
    }
    // Any other 4xx is a bad request: no retry.
    expect(classifyWhatsAppError(404, undefined)).toMatchObject({ kind: "PERMANENT" });
    expect(classifyWhatsAppError(400, { code: 999999 })).toMatchObject({ kind: "PERMANENT", code: 999999 });
  });
});
