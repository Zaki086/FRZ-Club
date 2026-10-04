// v5 §3.2: the one email layout every template email uses — header with the club logo and name (Settings → Club
// details), the body, a primary button when the record has a link, and a footer with the club's address and phone and
// why the person receives it. ANNOUNCEMENT emails add the one-click unsubscribe link; TRANSACTIONAL ones never do.
// The plain-text alternative is generated from the same parts. Every value is HTML-escaped. Pure functions.
import type { Recipient, TemplateCategory } from "./contract";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for HTML (element content and quoted attribute values). */
export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Escaped text with its http(s) links made clickable (the link text and href are the escaped URL). */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}" style="color:#0f766e;text-decoration:underline">${url}</a>`);
}

/** Plain text → HTML paragraphs: blank lines separate paragraphs, single newlines become line breaks. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px 0">${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export type EmailClub = { name: string; phone: string; address: string; logoUrl: string };

export type EmailParts = {
  subject: string;
  /** The rendered body (variables already filled in), plain text. */
  body: string;
  /** Absolute link for the button, or null (no button). */
  link: string | null;
  linkLabel: string;
  club: EmailClub;
  category: TemplateCategory;
  recipientKind: Recipient["kind"];
  /** ANNOUNCEMENT only: the signed one-click unsubscribe URL. */
  unsubscribeUrl: string | null;
};

/** Why this person gets the club's email (footer). */
export function receivingReason(kind: Recipient["kind"], club: string): string {
  const name = club || "the club";
  switch (kind) {
    case "MEMBER": return `You're receiving this because you're a member of ${name}.`;
    case "LEAD": return `You're receiving this because you asked ${name} about joining.`;
    case "GUEST": return `You're receiving this because you booked or visited ${name}.`;
    case "CONTACT": return `You're receiving this because you're a client of ${name}.`;
  }
}

/** The finished email: subject, HTML (club layout) and the plain-text alternative. */
export function buildEmail(p: EmailParts): { subject: string; html: string; text: string } {
  const club = p.club.name.trim();
  const unsubscribe = p.category === "ANNOUNCEMENT" ? p.unsubscribeUrl : null;
  const reason = receivingReason(p.recipientKind, club);
  const contact = [p.club.address.trim(), p.club.phone.trim()].filter(Boolean);

  const header = `
          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #e5e7eb">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                ${p.club.logoUrl ? `<td style="padding-right:12px;vertical-align:middle"><img src="${escapeHtml(p.club.logoUrl)}" alt="" width="40" height="40" style="display:block;border:0;border-radius:8px;width:40px;height:40px;object-fit:contain"></td>` : ""}
                <td style="vertical-align:middle;font-size:18px;font-weight:700;color:#111827">${escapeHtml(club)}</td>
              </tr></table>
            </td>
          </tr>`;
  const button = p.link
    ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px 0"><tr>
                <td style="border-radius:8px;background:#0f766e">
                  <a href="${escapeHtml(p.link)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(p.linkLabel)}</a>
                </td>
              </tr></table>`
    : "";
  const footer = `
          <tr>
            <td style="padding:20px 32px 28px 32px;border-top:1px solid #e5e7eb;font-size:12px;line-height:18px;color:#6b7280">
              ${club ? `<div style="font-weight:600;color:#374151">${escapeHtml(club)}</div>` : ""}
              ${contact.map((c) => `<div>${escapeHtml(c)}</div>`).join("")}
              <div style="margin-top:10px">${escapeHtml(reason)}</div>
              ${unsubscribe ? `<div style="margin-top:6px"><a href="${escapeHtml(unsubscribe)}" style="color:#6b7280;text-decoration:underline">Unsubscribe from announcements</a></div>` : ""}
            </td>
          </tr>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(p.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6">
    <tr>
      <td align="center" style="padding:24px 12px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">${header}
          <tr>
            <td style="padding:28px 32px 12px 32px;font-size:15px;line-height:23px">
${textToHtml(p.body)}${button}
            </td>
          </tr>${footer}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    p.body.trim(),
    p.link ? `${p.linkLabel}: ${p.link}` : "",
    ["—", club, ...contact].filter(Boolean).join("\n"),
    reason,
    unsubscribe ? `Unsubscribe from announcements: ${unsubscribe}` : "",
  ].filter(Boolean).join("\n\n");

  return { subject: p.subject.replace(/\s+/g, " ").trim(), html, text };
}

/** The email button's label for a deep link (decided by where the link goes). */
export function linkLabel(href: string, templateKey: string | null): string {
  const path = href.replace(/^https?:\/\/[^/]+/, "") || "/";
  const rules: Array<[RegExp, string]> = [
    [/^\/r\//, "Choose reschedule or refund"],
    [/^\/rq\//, "Show my collection QR"],
    [/^\/portal\/refunds\/[^/]+\/receipt/, "View my receipt"],
    [/^\/portal\/refunds/, "View my refund"],
    [/^\/portal\/bookings/, "View my booking"],
    [/^\/orders\//, "Track my order"],
    [/^\/portal\/orders/, "See my orders"],
    [/^\/portal\/tab/, "See my tab"],
    [/^\/quote\//, "View my quote"],
    [/^\/plans/, "See membership plans"],
    [/^\/portal\/invoices/, "View invoice"],
    [/^\/portal\/payments/, "See what's due"],
    [/^\/portal\/membership/, templateKey?.startsWith("membership_") ? "Renew my membership" : "Open my membership"],
    [/^\/portal\/social/, "Book my place"],
    [/^\/portal/, "Open the member portal"],
  ];
  return rules.find(([re]) => re.test(path))?.[1] ?? "Visit the club's website";
}

/** Push: what the device shows (short). */
export function pushText(title: string, body: string): { title: string; body: string } {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  return { title: cap(title.replace(/\s+/g, " ").trim(), 80), body: cap(body.replace(/\s*\n\s*/g, " ").trim(), 180) };
}
