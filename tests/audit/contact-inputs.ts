// v5 §2.3 (VALID) `audit:dummy` rule CV-10: every <input> for a phone, mobile or email must carry the shared
// validator wiring — `data-validate="phone" | "email" | "login"`, set only by the shared inputs in
// src/components/contact-inputs.tsx. Search boxes are excluded (§2.2.3): they accept partial numbers and names.
// Used by scripts/audit-dummy.ts (source scan of every .tsx in src/) and tests/audit/crawl.spec.ts (rendered pages).

/** Name / label / placeholder words that make an input a contact field. */
export const CONTACT_FIELD_SOURCE = String.raw`phone|mobile|e-?mail`;
/** Fields that are the content of a message (subject, body, title, text) rather than a phone or an address. */
export const MESSAGE_CONTENT_SOURCE = String.raw`(e-?mail|push|whats ?app|sms)[ _-]?(subject|body|title|text|message)`;
/** A lookup or search box: it says so, or it also accepts names / codes. */
export const SEARCH_BOX_SOURCE = String.raw`search|find|scan|look ?up|\bname\b|\bcode\b|\b(CC|LD|RF|BK|TB|SO|CS)-|booking|order`;
/** Input types that never hold a phone or email typed by a person. */
export const NON_TEXT_TYPES = ["checkbox", "radio", "hidden", "password", "file", "submit", "button", "reset", "range", "color", "date", "time", "datetime-local", "month", "week", "image"];

export type ContactVerdict = "ok" | "search" | "missing" | "n/a";
export type InputFacts = { type?: string | null; name?: string | null; id?: string | null; ariaLabel?: string | null; placeholder?: string | null; label?: string | null; dataValidate?: string | null; role?: string | null };

export function classifyContactInput(f: InputFacts): ContactVerdict {
  const type = (f.type ?? "text").toLowerCase();
  if (NON_TEXT_TYPES.includes(type)) return "n/a";
  const words = [f.name, f.id, f.ariaLabel, f.placeholder, f.label].filter(Boolean).join(" ");
  const isContact = new RegExp(CONTACT_FIELD_SOURCE, "i").test(words) || type === "tel" || type === "email";
  if (!isContact) return "n/a";
  // Message content fields ("Email subject", "Email body", emailSubject…) hold text about an email, not an address.
  if (type !== "tel" && type !== "email" && new RegExp(MESSAGE_CONTENT_SOURCE, "i").test(words)) return "n/a";
  if (f.dataValidate && /^(phone|email|login)$/.test(f.dataValidate)) return "ok";
  if (type === "search" || f.role === "searchbox" || new RegExp(SEARCH_BOX_SOURCE, "i").test(words)) return "search";
  return "missing";
}

/** End of a JSX opening tag that starts at `start` (index just after the tag's closing `>`), aware of {…} and quotes. */
function tagEnd(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[i - 1] !== "=") return i + 1;
  }
  return src.length;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\}|\\{([^}]*)\\})`).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "") : null;
}

/** Text of the nearest enclosing <Field label="…"> or <label>…, if the tag sits inside one. */
function enclosingLabel(src: string, at: number): string | null {
  const before = src.slice(0, at);
  const field = before.lastIndexOf("<Field");
  if (field >= 0 && before.indexOf("</Field>", field) < 0) {
    const open = src.slice(field, tagEnd(src, field));
    const l = attr(open, "label");
    if (l) return l;
  }
  const label = before.lastIndexOf("<label");
  if (label >= 0 && before.indexOf("</label>", label) < 0) return before.slice(label).replace(/<[^>]*>|\{[^}]*\}/g, " ");
  return null;
}

export type SourceHit = { line: number; text: string; verdict: Exclude<ContactVerdict, "ok" | "n/a"> };

/** Raw <input> / <Input> elements in a .tsx source that look like a phone or email field without the shared wiring. */
export function scanContactInputs(src: string): SourceHit[] {
  const out: SourceHit[] = [];
  const re = /<(input|Input)(?=[\s/>])/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = tagEnd(src, m.index);
    const tag = src.slice(m.index, end);
    const verdict = classifyContactInput({
      type: attr(tag, "type"),
      name: attr(tag, "name"),
      id: attr(tag, "id"),
      ariaLabel: attr(tag, "aria-label"),
      placeholder: attr(tag, "placeholder"),
      label: enclosingLabel(src, m.index),
      dataValidate: attr(tag, "data-validate"),
      role: attr(tag, "role"),
    });
    if (verdict === "missing" || verdict === "search") {
      out.push({ line: src.slice(0, m.index).split("\n").length, text: tag.replace(/\s+/g, " ").slice(0, 140), verdict });
    }
  }
  return out;
}
