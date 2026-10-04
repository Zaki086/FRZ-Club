// v5 §3.3–3.4 (MSGUI): the composer's and the bulk dialog's own decisions — what is pre-picked, which channels are
// offered (unavailable ones hidden), when the wa.me tab opens, what "edit for this send" sends, how a selection travels
// to the bulk API, the progress/summary figures and the "Send next" order. The server's rules (roles, opt-outs,
// rendering, the duplicate guard) are MSGCORE's tests; these never decide anything the server doesn't check again.
import { describe, expect, it } from "vitest";
import {
  bulkChannelLines,
  bulkContext,
  bulkFinished,
  bulkPercent,
  bulkTarget,
  channelsWithFillIn,
  defaultChannels,
  duplicateQuestion,
  emailBodyForEdit,
  fillInLeft,
  hiddenChannelReasons,
  initialTemplate,
  keepChannels,
  nextInQueue,
  offerAutoWhatsApp,
  offeredChannels,
  opensWhatsApp,
  overridesFor,
  renderedFields,
  resultLabel,
  type QueueRow,
} from "@/components/message-composer-logic";
import { BULK_MAX, type BulkProgress, type ComposerTemplate, type TemplateChannel } from "@/server/services/messages/contract";
import { buildEmail } from "@/server/services/messages/render";

function tpl(over: Partial<ComposerTemplate> & { offer?: TemplateChannel[] } = {}): ComposerTemplate {
  const offer = over.offer ?? ["WHATSAPP", "EMAIL", "PUSH"];
  const all: TemplateChannel[] = ["WHATSAPP", "EMAIL", "PUSH"];
  return {
    id: "t1", key: "dues_reminder", name: "Dues reminder", context: "MEMBER", category: "TRANSACTIONAL", version: 1,
    channels: all,
    channelOptions: all.map((c) => ({ channel: c, available: offer.includes(c), reason: offer.includes(c) ? null : c === "EMAIL" ? "no email address" : "no device with push" })),
    availableChannels: offer, autoWhatsApp: false, recommended: false, canSend: true, lastSentAt: null,
    ...over,
  };
}

describe("v5 §3.3 composer — template and channels", () => {
  it("step 1: the server's most relevant template is pre-picked; none when nothing is recommended", () => {
    const a = tpl({ id: "a", recommended: false });
    const b = tpl({ id: "b", recommended: true });
    expect(initialTemplate([b, a])?.id).toBe("b");
    expect(initialTemplate([a])).toBeNull();
    expect(initialTemplate([])).toBeNull();
  });

  it("step 2: only channels available for this recipient are offered — the others are hidden, with the reason as a hint", () => {
    const t = tpl({ offer: ["WHATSAPP"] });
    expect(offeredChannels(t)).toEqual(["WHATSAPP"]);
    expect(hiddenChannelReasons(t)).toEqual(["Email: no email address", "Push: no device with push"]);
    // availableChannels and channelOptions must agree; either one saying "no" hides the channel.
    expect(offeredChannels({ ...t, availableChannels: ["WHATSAPP", "EMAIL"] })).toEqual(["WHATSAPP"]);
    expect(offeredChannels(tpl({ offer: [] }))).toEqual([]);
    expect(offeredChannels(null)).toEqual([]);
  });

  it("step 2: one channel is pre-ticked (WhatsApp, then email, then push); a new template keeps what it still offers", () => {
    expect(defaultChannels(tpl())).toEqual(["WHATSAPP"]);
    expect(defaultChannels(tpl({ offer: ["PUSH", "EMAIL"] }))).toEqual(["EMAIL"]);
    expect(defaultChannels(tpl({ offer: [] }))).toEqual([]);
    expect(keepChannels(tpl({ offer: ["EMAIL", "PUSH"] }), ["WHATSAPP", "PUSH"])).toEqual(["PUSH"]);
    expect(keepChannels(tpl({ offer: ["EMAIL"] }), ["WHATSAPP"])).toEqual(["EMAIL"]);
  });

  it("step 4: \"Send automatically on WhatsApp\" only when the server offers it and WhatsApp is ticked; otherwise wa.me opens", () => {
    expect(offerAutoWhatsApp(tpl({ autoWhatsApp: true }), ["WHATSAPP"])).toBe(true);
    expect(offerAutoWhatsApp(tpl({ autoWhatsApp: true }), ["EMAIL"])).toBe(false);
    expect(offerAutoWhatsApp(tpl({ autoWhatsApp: false }), ["WHATSAPP"])).toBe(false);
    expect(opensWhatsApp(["WHATSAPP", "EMAIL"], false)).toBe(true);
    expect(opensWhatsApp(["WHATSAPP"], true)).toBe(false);
    expect(opensWhatsApp(["EMAIL", "PUSH"], false)).toBe(false);
  });
});

describe("v5 §3.3 step 3 — edit for this send only", () => {
  const rendered = renderedFields(
    { whatsapp: { text: "Hi Rahul, ₹500 is due.", length: 22, waLink: "https://wa.me/919811000001?text=x" }, email: { subject: "Dues", text: "Body", html: "<p>Body</p>" }, push: { title: "Dues", body: "₹500 due" } },
    null,
  );

  it("sends only fields that were edited, changed, and belong to a ticked channel", () => {
    expect(overridesFor(["WHATSAPP"], {}, rendered)).toBeUndefined();
    expect(overridesFor(["WHATSAPP"], { whatsappText: "Hi Rahul, ₹500 is due." }, rendered)).toBeUndefined(); // opened, not changed
    expect(overridesFor(["WHATSAPP"], { whatsappText: "Hi Rahul, please pay ₹500 today." }, rendered)).toEqual({ whatsappText: "Hi Rahul, please pay ₹500 today." });
    // Email edited but only WhatsApp ticked: nothing for email goes out.
    expect(overridesFor(["WHATSAPP"], { emailSubject: "Changed" }, rendered)).toBeUndefined();
    expect(overridesFor(["EMAIL", "PUSH"], { emailSubject: "Changed", pushBody: "₹500 due" }, rendered)).toEqual({ emailSubject: "Changed" });
    // An emptied box is not an override (the server would refuse an empty message anyway).
    expect(overridesFor(["PUSH"], { pushTitle: "   " }, rendered)).toBeUndefined();
  });
});

describe("v5 §3.3 step 3 — the email body and [[fill-in]] parts", () => {
  const club = { name: "Champions Club", phone: "+91 98110 00000", address: "12 Court Road, Pune", logoUrl: "" };
  const email = (body: string, link: string | null, category: "TRANSACTIONAL" | "ANNOUNCEMENT") =>
    buildEmail({ subject: "Dues", body, link, linkLabel: "Pay your dues", club, category, recipientKind: "MEMBER", unsubscribeUrl: category === "ANNOUNCEMENT" ? "https://club.example/u/abc" : null });

  it("an edit starts from the body only — not the button line, the club block, the reason or the unsubscribe line", () => {
    const body = "Hi Rahul,\n\n₹500 is due at the front desk.\n\n— see you soon";
    expect(emailBodyForEdit(email(body, "https://club.example/portal/dues", "TRANSACTIONAL").text, "https://club.example/portal/dues")).toBe(body);
    expect(emailBodyForEdit(email(body, null, "ANNOUNCEMENT").text, null)).toBe(body);
    expect(emailBodyForEdit(email("Short note.", null, "TRANSACTIONAL").text, null)).toBe("Short note.");
  });

  it("a [[fill-in]] left in a ticked channel blocks sending; its edit box opens by itself", () => {
    const base = { whatsappText: "Notice: *[[What is changing]]*", emailSubject: "Notice: [[closure]]", emailBody: "Hello", pushTitle: "Notice", pushBody: "Courts open" };
    expect(channelsWithFillIn(["WHATSAPP", "EMAIL", "PUSH"], base)).toEqual(["WHATSAPP", "EMAIL"]);
    expect(fillInLeft(["PUSH"], {}, base)).toBe(false);
    expect(fillInLeft(["WHATSAPP"], {}, base)).toBe(true);
    expect(fillInLeft(["WHATSAPP"], { whatsappText: "Notice: *Courts 1–2 closed Sunday 6–10 am*" }, base)).toBe(false);
    expect(fillInLeft(["WHATSAPP", "EMAIL"], { whatsappText: "Notice: *Courts closed Sunday*" }, base)).toBe(true); // email subject still to write
  });
});

describe("v5 §3.3 step 4 — results and the duplicate guard", () => {
  it("labels per channel: manual WhatsApp waits for staff; automatic WhatsApp is queued; email/push show SENT/FAILED", () => {
    expect(resultLabel({ channel: "WHATSAPP_MANUAL", status: "QUEUED" })).toBe("To send");
    expect(resultLabel({ channel: "WHATSAPP_MANUAL", status: "LINK_OPENED" })).toBe("WhatsApp opened");
    expect(resultLabel({ channel: "WHATSAPP_MANUAL", status: "SENT" })).toBe("Sent");
    expect(resultLabel({ channel: "WHATSAPP_API", status: "QUEUED" })).toBe("Queued — sent automatically");
    expect(resultLabel({ channel: "EMAIL", status: "FAILED" })).toBe("Failed");
    expect(resultLabel({ channel: "PUSH", status: "SENT" })).toBe("Sent");
  });

  it("DUPLICATE_RECENT_SEND asks before sending again (single and bulk wording)", () => {
    const when = (iso: string) => iso.slice(0, 10);
    expect(duplicateQuestion({ lastSentAt: "2026-10-03T05:00:00Z", sentBy: "Farah Desk" }, "Rahul Mehta", when)).toBe(
      "Rahul Mehta already got this message on 2026-10-03 (sent by Farah Desk). Send it again?",
    );
    expect(duplicateQuestion({}, "Rahul Mehta", when)).toBe("Rahul Mehta already got this message. Send it again?");
    const many = duplicateQuestion({ lastSentAt: "x", sentBy: null, recipients: [1, 2, 3, 4].map((i) => ({ name: `M${i}`, lastSentAt: "x" })) }, "", when);
    expect(many).toBe("4 recipients got this message in the last 24 hours (M1, M2, M3…). Send it to them again?");
  });
});

describe("v5 §3.4 bulk", () => {
  it("picked rows travel as ids (deduplicated, at most 500); \"all N matching\" travels as the list filter without paging", () => {
    expect(bulkTarget({ ids: ["a", "b", "a"], allMatching: false, qs: "status=EXPIRING" })).toEqual({ ids: ["a", "b"] });
    const many = Array.from({ length: BULK_MAX + 20 }, (_, i) => `m${i}`);
    expect(bulkTarget({ ids: many, allMatching: false, qs: "" }).ids).toHaveLength(BULK_MAX);
    expect(bulkTarget({ ids: [], allMatching: true, qs: "why=dues&page=3&size=50&sort=dues" })).toEqual({ filter: "why=dues&sort=dues" });
    expect(BULK_MAX).toBe(500);
  });

  it("members, renewals and check-in risk send member templates; the leads board sends lead templates", () => {
    expect(bulkContext("members")).toBe("MEMBER");
    expect(bulkContext("renewals")).toBe("MEMBER");
    expect(bulkContext("checkin-risk")).toBe("MEMBER");
    expect(bulkContext("leads")).toBe("LEAD");
  });

  const counts = (total: number, sent: number, failed: number, queued: number, linkOpened = 0) => ({ total, sent, failed, queued, linkOpened });
  const progress = (over: Partial<BulkProgress> = {}): BulkProgress => ({
    id: "b1", status: "SENDING", template: { id: "t", name: "Club notice", version: 1, category: "ANNOUNCEMENT" }, list: "members", channels: ["EMAIL", "PUSH", "WHATSAPP"],
    createdAt: "", createdBy: "Manish Manager", finishedAt: null, total: 3,
    queued: counts(4, 1, 1, 2),
    perChannel: { EMAIL: counts(2, 1, 0, 1), PUSH: counts(2, 0, 1, 1), WHATSAPP_MANUAL: counts(3, 1, 0, 1, 1) },
    manual: { total: 3, toSend: 1, opened: 1, sent: 1, nextId: "d2" }, skipped: [{ name: "Neha Kapoor", reason: "unsubscribed from announcements", channel: "EMAIL" }], etaSeconds: 2,
    ...over,
  });

  it("progress: the worker's share done (email, push, automatic WhatsApp); 100 when done or nothing queued", () => {
    expect(bulkPercent(progress())).toBe(50);
    expect(bulkPercent(progress({ queued: counts(0, 0, 0, 0) }))).toBe(100);
    expect(bulkPercent(progress({ status: "DONE" }))).toBe(100);
  });

  it("summary: one line per channel; finished only when the worker is done and no WhatsApp is left to send by hand", () => {
    expect(bulkChannelLines(progress())).toEqual([
      { channel: "WHATSAPP_MANUAL", label: "WhatsApp (by hand)", text: "1 sent, 1 opened, 1 to send" },
      { channel: "EMAIL", label: "Email", text: "1 sent, 1 queued" },
      { channel: "PUSH", label: "Push", text: "0 sent, 1 failed, 1 queued" },
    ]);
    expect(bulkFinished(progress())).toBe(false);
    expect(bulkFinished(progress({ status: "DONE" }))).toBe(false);
    expect(bulkFinished(progress({ status: "DONE", manual: { total: 3, toSend: 0, opened: 0, sent: 3, nextId: null } }))).toBe(true);
  });
});

describe("v5 §3.4 Messages to Send — \"Send next\"", () => {
  const row = (id: string, status = "QUEUED"): QueueRow => ({ id, status, title: "Dues reminder", member_name: id, recipient: id, to_address: "919811000001", created_at: "" });

  it("offers the oldest message still to send, never the one open now or one skipped in this run", () => {
    const q = [row("a", "SENT"), row("b"), row("c", "LINK_OPENED"), row("d")];
    expect(nextInQueue(q, [], null)?.id).toBe("b");
    expect(nextInQueue(q, [], "b")?.id).toBe("c");
    expect(nextInQueue(q, ["b"], "c")?.id).toBe("d");
    expect(nextInQueue(q, ["b", "d"], "c")).toBeNull();
    expect(nextInQueue([], [], null)).toBeNull();
  });
});
