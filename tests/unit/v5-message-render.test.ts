// v5 §3.1–3.2 (MSGCORE): template variables (MT-1), rendering, HTML escaping, the email layout, the wa.me link and the
// ready-made templates' text — pure functions, no database.
import { describe, expect, it } from "vitest";
import { FILL_IN_RE, TEMPLATE_CONTEXTS, WHATSAPP_MAX_CHARS } from "@/server/services/messages/contract";
import { READY_MADE_TEMPLATES } from "@/server/services/messages/ready-made";
import { buildEmail, escapeHtml, linkLabel, pushText, textToHtml } from "@/server/services/messages/render";
import {
  AUTO_WHATSAPP, extractVariables, hasFillIn, maskEmail, maskPhone, renderText, unknownVariables, variablesForContext, waMeLink,
} from "@/server/services/messages/variables";

const CLUB = { name: "Riverside Racquet Club", phone: "98250 12345", address: "12 Lake Road, Vastrapur", logoUrl: "https://club.example.in/uploads/logo.png" };

describe("MT-1 template variables per context", () => {
  it("MT-1: each context has only its own variables plus club.*, portal.url and link", () => {
    const names = (c: (typeof TEMPLATE_CONTEXTS)[number]) => variablesForContext(c).map((v) => v.name).sort();
    const common = ["club.address", "club.name", "club.phone", "link", "portal.url"];
    expect(names("MEMBER")).toEqual([...common, "dues.amount", "member.code", "member.first_name", "membership.end_date", "membership.plan"].sort());
    expect(names("BOOKING")).toEqual([...common, "booking.code", "booking.court", "booking.date", "booking.time", "member.first_name"].sort());
    expect(names("REFUND")).toEqual([...common, "member.first_name", "refund.amount", "refund.code"].sort());
    expect(names("ORDER")).toEqual([...common, "member.first_name", "order.code"].sort());
    expect(names("TAB")).toEqual([...common, "member.first_name", "tab.total"].sort());
    expect(names("LEAD")).toEqual([...common, "lead.first_name"].sort());
    expect(names("INVOICE")).toEqual([...common, "invoice.due_date", "invoice.number", "member.first_name"].sort());
    expect(names("GENERAL")).toEqual(common.sort());
  });

  it("MT-1: variables another context owns, unknown names and broken braces are reported", () => {
    expect(unknownVariables("MEMBER", ["Hi {{member.first_name}}, {{dues.amount}} due. {{club.name}} {{link}}"])).toEqual([]);
    expect(unknownVariables("MEMBER", ["Your booking {{booking.code}}"])).toEqual(["{{booking.code}}"]);
    expect(unknownVariables("BOOKING", ["{{member.code}} {{membership.plan}}"])).toEqual(["{{member.code}}", "{{membership.plan}}"]);
    expect(unknownVariables("GENERAL", ["Hi {{member.first_name}}"])).toEqual(["{{member.first_name}}"]);
    expect(unknownVariables("LEAD", ["Hi {{lead.first_name}} {{ lead.first_name }}"])).toEqual([]);
    expect(unknownVariables("LEAD", ["Hi {{lead.name}}"])).toEqual(["{{lead.name}}"]);
    expect(unknownVariables("MEMBER", ["Hi {{member.first_name}"])).toHaveLength(1);
    expect(unknownVariables("MEMBER", ["Hi {{member first}}"])).toHaveLength(1);
    expect(unknownVariables("MEMBER", ["Hi member.first_name}}"])).toHaveLength(1);
    expect(extractVariables("a {{x.y}} b {{ link }}")).toEqual(["x.y", "link"]);
  });

  it("MT-2: renders values; a line whose variables are all empty is left out; blank lines don't pile up", () => {
    const text = "Hi {{member.first_name}},\n\nView it: {{link}}\n\n\nQuestions? Call {{club.phone}}.\n— {{club.name}}";
    expect(renderText(text, { "member.first_name": "Asha", link: "", "club.phone": "", "club.name": "Riverside" })).toBe("Hi Asha,\n\n— Riverside");
    expect(renderText(text, { "member.first_name": "Asha", link: "https://x.in/p", "club.phone": "98250 12345", "club.name": "R" }))
      .toBe("Hi Asha,\n\nView it: https://x.in/p\n\nQuestions? Call 98250 12345.\n— R");
    // Values are inserted as plain text (no escaping, no re-interpretation of braces inside values).
    expect(renderText("Hi {{member.first_name}}", { "member.first_name": "<b>{{link}}</b>" })).toBe("Hi <b>{{link}}</b>");
  });

  it("MT-18: a [[fill-in]] part is detected (club notice details)", () => {
    expect(hasFillIn("Notice: *[[What is changing]]*")).toBe(true);
    expect(hasFillIn("Notice: courts closed Sunday")).toBe(false);
    expect(FILL_IN_RE.test("[[x]]")).toBe(true);
  });
});

describe("§3.2 email layout and HTML escaping", () => {
  it("MT-9: escapes every value; links become buttons/anchors with escaped URLs", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'q'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
    const html = textToHtml("Hi <b>Asha</b> & co,\nline two\n\nSee https://x.in/a?b=1&c=2.");
    expect(html).toContain("Hi &lt;b&gt;Asha&lt;/b&gt; &amp; co,<br>line two");
    expect(html).toContain('<a href="https://x.in/a?b=1&amp;c=2"');
    expect(html).not.toContain("<b>");
  });

  it("MT-9/MT-10: header with logo + club name, body, button for the link, footer with address, phone and why — transactional has no unsubscribe", () => {
    const e = buildEmail({
      subject: "Amount due  at Riverside", body: "Hi Asha,\n\n₹1,550 is due.", link: "https://club.example.in/portal/payments", linkLabel: "See what's due",
      club: CLUB, category: "TRANSACTIONAL", recipientKind: "MEMBER", unsubscribeUrl: "https://club.example.in/unsubscribe/UN1.m.x.y",
    });
    expect(e.subject).toBe("Amount due at Riverside");
    expect(e.html).toContain('<img src="https://club.example.in/uploads/logo.png"');
    expect(e.html).toContain("Riverside Racquet Club");
    expect(e.html).toContain('href="https://club.example.in/portal/payments"');
    expect(e.html).toContain("See what&#39;s due");
    expect(e.html).toContain("12 Lake Road, Vastrapur");
    expect(e.html).toContain("98250 12345");
    expect(e.html).toContain("You&#39;re receiving this because you&#39;re a member of Riverside Racquet Club.");
    expect(e.html).not.toContain("unsubscribe");
    expect(e.html).toContain('name="viewport"');
    // Plain-text alternative: body, the link, the club, why.
    expect(e.text).toContain("Hi Asha,\n\n₹1,550 is due.");
    expect(e.text).toContain("See what's due: https://club.example.in/portal/payments");
    expect(e.text).toContain("Riverside Racquet Club\n12 Lake Road, Vastrapur\n98250 12345");
    expect(e.text).toContain("You're receiving this because you're a member of Riverside Racquet Club.");
    expect(e.text).not.toMatch(/unsubscribe/i);
  });

  it("MT-10: an announcement carries the unsubscribe link (HTML and text); no link → no button; a club name with markup is escaped", () => {
    const e = buildEmail({
      subject: "Friday social", body: "Hello!", link: null, linkLabel: "", club: { ...CLUB, name: `Club "<A&B>"`, logoUrl: "" }, category: "ANNOUNCEMENT",
      recipientKind: "MEMBER", unsubscribeUrl: "https://club.example.in/unsubscribe/UN1.m.abc.def",
    });
    expect(e.html).toContain('href="https://club.example.in/unsubscribe/UN1.m.abc.def"');
    expect(e.html).toContain("Unsubscribe from announcements");
    expect(e.text).toContain("Unsubscribe from announcements: https://club.example.in/unsubscribe/UN1.m.abc.def");
    expect(e.html).toContain("Club &quot;&lt;A&amp;B&gt;&quot;");
    expect(e.html).not.toContain("<A&B>");
    expect(e.html).not.toContain("<img");
    expect(e.html).not.toContain("border-radius:8px;background:#0f766e");
  });

  it("MT-9: button labels follow where the link goes; push text is short", () => {
    expect(linkLabel("https://c.in/rq/RF1.x.y", null)).toBe("Show my collection QR");
    expect(linkLabel("https://c.in/r/R1.a.b.c", null)).toBe("Choose reschedule or refund");
    expect(linkLabel("https://c.in/portal/membership", "membership_expiring")).toBe("Renew my membership");
    expect(linkLabel("https://c.in/portal/membership", null)).toBe("Open my membership");
    expect(linkLabel("https://c.in/quote/tok", null)).toBe("View my quote");
    expect(linkLabel("https://c.in/", null)).toBe("Visit the club's website");
    const p = pushText("T".repeat(100), "line one\nline two " + "x".repeat(300));
    expect(p.title.length).toBe(80);
    expect(p.body.startsWith("line one line two")).toBe(true);
    expect(p.body.length).toBe(180);
  });
});

describe("§3.3 manual WhatsApp link and masking", () => {
  it("MT-8: wa.me/91<phone>?text=<URL-encoded text>", () => {
    const text = "Hi Asha, *₹1,550* is due & payable.\nThanks!";
    const url = waMeLink("919811000001", text);
    expect(url.startsWith("https://wa.me/919811000001?text=")).toBe(true);
    expect(url).toContain("%E2%82%B91%2C550"); // ₹1,550
    expect(url).toContain("%26"); // &
    expect(url).toContain("%0A"); // newline
    expect(url).not.toContain(" ");
    expect(decodeURIComponent(url.split("?text=")[1])).toBe(text);
  });

  it("MT-6: recipients are masked", () => {
    expect(maskPhone("9811000001")).toBe("+91 ••••••0001");
    expect(maskPhone("919811000001")).toBe("+91 ••••••0001");
    expect(maskEmail("asha.k@gmail.com")).toBe("as•••@gmail.com");
    expect(maskEmail("a@b.in")).toBe("a•••@b.in");
    expect(maskEmail("not-an-email")).toBeNull();
  });
});

describe("§3.1 the 18 ready-made templates", () => {
  const spec: Array<[string, string, string]> = [
    ["membership_expiring", "MEMBER", "TRANSACTIONAL"], ["membership_expired", "MEMBER", "TRANSACTIONAL"], ["dues_reminder", "MEMBER", "TRANSACTIONAL"],
    ["welcome_portal", "MEMBER", "TRANSACTIONAL"], ["booking_reminder", "BOOKING", "TRANSACTIONAL"], ["booking_cancelled", "BOOKING", "TRANSACTIONAL"],
    ["session_cancelled_by_club", "BOOKING", "TRANSACTIONAL"], ["reschedule_confirmed", "BOOKING", "TRANSACTIONAL"], ["refund_ready", "REFUND", "TRANSACTIONAL"],
    ["refund_collected", "REFUND", "TRANSACTIONAL"], ["order_ready", "ORDER", "TRANSACTIONAL"], ["restring_ready", "ORDER", "TRANSACTIONAL"],
    ["settle_tab", "TAB", "TRANSACTIONAL"], ["trial_follow_up", "LEAD", "TRANSACTIONAL"], ["quote_follow_up", "LEAD", "TRANSACTIONAL"],
    ["invoice_due", "INVOICE", "TRANSACTIONAL"], ["friday_social", "GENERAL", "ANNOUNCEMENT"], ["club_notice", "GENERAL", "ANNOUNCEMENT"],
  ];

  it("MT-17: all 18, in the spec's order, with the right context and category", () => {
    expect(READY_MADE_TEMPLATES.map((t) => [t.key, t.context, t.category])).toEqual(spec);
    expect(new Set(READY_MADE_TEMPLATES.map((t) => t.name.toLowerCase())).size).toBe(18);
  });

  it("MT-17: every template: valid variables, WhatsApp + email (+ push for people with the app), the club name and a next step", () => {
    for (const t of READY_MADE_TEMPLATES) {
      const texts = [t.whatsappText, t.emailSubject, t.emailBody, t.pushTitle, t.pushBody];
      expect([t.key, unknownVariables(t.context, texts)]).toEqual([t.key, []]);
      expect(t.channels).toContain("WHATSAPP");
      expect(t.channels).toContain("EMAIL");
      expect(t.channels.includes("PUSH")).toBe(t.context !== "LEAD");
      if (t.channels.includes("PUSH")) expect(!!t.pushTitle && !!t.pushBody).toBe(true);
      expect(t.whatsappText).toMatch(/\*[^*\n]+\*/); // *bold* key facts
      expect(t.whatsappText + t.emailBody).toContain("{{club.name}}");
      expect(t.whatsappText).toMatch(/\{\{(link|portal\.url|club\.phone)\}\}/); // a clear next step
      expect(t.whatsappText).not.toMatch(/\b(lorem|dummy|TODO)\b/i);
      if (t.waTemplate) expect(AUTO_WHATSAPP[t.waTemplate].context).toBe(t.context);
    }
  });

  it("MT-17: WhatsApp text stays under 700 characters even with long real values", () => {
    const long = {
      "member.first_name": "Venkataramanan", "member.code": "CC-GOLD-00123", "membership.plan": "Gold", "membership.end_date": "30 Sep 2027", "dues.amount": "₹12,34,550.50",
      "booking.code": "BK-000123", "booking.court": "Centre Court (Clay)", "booking.date": "Wed, 30 Sep 2026", "booking.time": "10:30 pm–11:30 pm",
      "refund.code": "RF-000123", "refund.amount": "₹12,550", "order.code": "SO-000123", "tab.total": "₹12,550", "lead.first_name": "Venkataramanan",
      "invoice.number": "CC/2026-27/00123", "invoice.due_date": "30 Sep 2026", "club.name": "Riverside Racquet & Sports Club", "club.phone": "+91 98250 12345",
      "club.address": "x".repeat(200), "portal.url": "https://riverside-racquet-club.example.in/portal",
      link: "https://riverside-racquet-club.example.in/rq/RF1.cmh2x9k3a0001qw8e7r6t5y4u.abcdefghijklmnopqrstuvwxyz012345",
    };
    for (const t of READY_MADE_TEMPLATES) {
      const out = renderText(t.whatsappText.replace(/\[\[[^\]]*\]\]/g, "Courts 1 and 2 are closed on Sunday 12 Oct, 6–10 am, for resurfacing"), long);
      expect([t.key, out.length < WHATSAPP_MAX_CHARS]).toEqual([t.key, true]);
    }
  });

  it("MT-17: only the club notice has a part staff must write; it is in every channel's text", () => {
    for (const t of READY_MADE_TEMPLATES) {
      const all = [t.whatsappText, t.emailSubject, t.emailBody, t.pushTitle, t.pushBody].join("\n");
      expect([t.key, hasFillIn(all)]).toEqual([t.key, t.key === "club_notice"]);
    }
    const notice = READY_MADE_TEMPLATES.find((t) => t.key === "club_notice")!;
    for (const s of [notice.whatsappText, notice.emailSubject, notice.emailBody, notice.pushBody]) expect(hasFillIn(s)).toBe(true);
  });
});
