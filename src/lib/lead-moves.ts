// v6 §3 leads board: which column moves are allowed, and what each one does. The board (drag & drop and the
// "Move to…" menu, LD-2) uses this to decide what to open; the server (`moveLead` in services/crm.ts) enforces it.

export const LEAD_COLUMNS = ["NEW", "CONTACTED", "QUOTED", "WON", "LOST"] as const;
export type LeadColumn = (typeof LEAD_COLUMNS)[number];

export const LEAD_COLUMN_TITLE: Record<LeadColumn, string> = { NEW: "New", CONTACTED: "Contacted", QUOTED: "Quoted", WON: "Won", LOST: "Lost" };

/**
 * - `contact`: New → Contacted, immediately (an optional quick note follows, logged as an activity).
 * - `quote`: → Quoted for a lead that already has a quote.
 * - `quote-builder`: → Quoted for a lead with no quote — the quote builder opens; creating the quote moves it.
 * - `convert`: → Won opens "Convert to member"; the lead is WON only when the membership is paid (CR-7).
 * - `lost`: → Lost with a required reason.
 * - `reopen`: Lost → New/Contacted, Manager/Owner only, with a reason.
 */
export type LeadMoveKind = "contact" | "quote" | "quote-builder" | "convert" | "lost" | "reopen";
export type LeadMoveCheck = { ok: true; kind: LeadMoveKind } | { ok: false; why: string };

export const WON_IS_FINAL = "Won is final — a won lead can't be moved to another column.";
export const REOPEN_NEEDS_MANAGER = "Only a Manager or the Owner can reopen a lost lead.";

const OPEN: LeadColumn[] = ["NEW", "CONTACTED", "QUOTED"];

export function leadMove(from: LeadColumn, to: LeadColumn, opts: { hasQuote: boolean; canReopen: boolean; canConvert?: boolean }): LeadMoveCheck {
  if (from === to) return { ok: false, why: `The lead is already ${LEAD_COLUMN_TITLE[to]}.` };
  if (from === "WON") return { ok: false, why: WON_IS_FINAL };
  if (from === "LOST") {
    if (to === "NEW" || to === "CONTACTED") return opts.canReopen ? { ok: true, kind: "reopen" } : { ok: false, why: REOPEN_NEEDS_MANAGER };
    return { ok: false, why: "A lost lead is reopened to New or Contacted first (Manager or Owner)." };
  }
  // From here the lead is open (New, Contacted or Quoted).
  switch (to) {
    case "CONTACTED":
      return from === "NEW" ? { ok: true, kind: "contact" } : { ok: false, why: "A quoted lead can't move back to Contacted." };
    case "QUOTED":
      return { ok: true, kind: opts.hasQuote ? "quote" : "quote-builder" };
    case "WON":
      return opts.canConvert === false ? { ok: false, why: "Converting a lead needs a login that can sign up members." } : { ok: true, kind: "convert" };
    case "LOST":
      return { ok: true, kind: "lost" };
    case "NEW":
      return { ok: false, why: `A ${LEAD_COLUMN_TITLE[from].toLowerCase()} lead can't move back to New.` };
  }
  return { ok: false, why: "That move isn't allowed." };
}

export const isOpenLead = (s: LeadColumn) => OPEN.includes(s);

/** The existing "Convert to member" flow: the New member form, pre-filled and linked to the lead (CR-7). */
export const convertLeadUrl = (l: { id: string; name: string; phone: string | null; email: string | null }) =>
  `/app/members/new?leadId=${l.id}&name=${encodeURIComponent(l.name)}&phone=${encodeURIComponent(l.phone ?? "")}&email=${encodeURIComponent(l.email ?? "")}`;
