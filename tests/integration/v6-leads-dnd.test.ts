// v6 §3 — leads board drag & drop / "Move to…": one rule test per allowed and forbidden column move (LD-1…LD-4),
// on the server's `moveLead` (the board's drop and menu both call POST /api/crm/leads/<id>/move), and DESK-1 — the
// front desk's Check-in & Search Members lists every member.
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { prisma } from "@/server/db";
import { errorResponse } from "@/server/http";
import { createLead, createQuote, logActivity, moveLead, moveSchema } from "@/server/services/crm";
import { createMember } from "@/server/services/membership";
import { listView } from "@/server/services/filters";
import { canOpenPage } from "@/server/rbac/page-access";
import { navPaths } from "@/app/(staff)/app/_nav";
import { LEAD_COLUMNS, leadMove, REOPEN_NEEDS_MANAGER, WON_IS_FINAL, type LeadColumn } from "@/lib/lead-moves";
import { makeWorld, utr, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";

let w: World;
let phone = 9876540000;
beforeEach(async () => {
  w = await makeWorld();
});

const newLead = async (name = "Board Bina") => createLead(w.actors.FRONT_DESK, { name, phone: String(++phone), source: "WALK_IN", interest: "Silver membership" });
const status = async (id: string) => (await prisma.lead.findUniqueOrThrow({ where: { id } })).status;
const moves = (id: string) => prisma.auditLog.findMany({ where: { entity: "lead", entityId: id, action: "lead.move" }, orderBy: { at: "asc" } });
const timeline = (id: string) => prisma.leadActivity.findMany({ where: { leadId: id }, orderBy: { at: "asc" } });

/** The HTTP answer the board shows (route pipeline: DomainError → errorResponse). */
async function http(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const res = errorResponse(e);
    const j = (await res.json()) as { error: { code: string; message: string } };
    return { status: res.status, ...j.error };
  }
  throw new Error("expected the move to be refused");
}

async function quotedLead() {
  const l = await newLead("Quoted Qadir");
  await createQuote(w.actors.FRONT_DESK, l.id, { lines: [{ planCode: "SILVER", months: 1 }] });
  return l;
}
async function lostLead() {
  const l = await newLead("Lost Lata");
  await moveLead(w.actors.FRONT_DESK, l.id, { to: "LOST", reason: "joined another club" });
  return l;
}
async function wonLead() {
  const l = await newLead("Won Waris");
  await createMember(w.actors.FRONT_DESK, { name: l.name, phone: l.phone!, dob: "1992-03-03", leadId: l.id, plan: { code: "SILVER", months: 1, payment: { method: "UPI", reference: utr() } } });
  expect(await status(l.id)).toBe("WON");
  return l;
}

describe("v6 §3 — the move rules (lib/lead-moves.ts, shared by the board and the server)", () => {
  it("LD-1: the full 5×5 table — allowed moves and what they open; everything else says why", () => {
    const ok = (from: LeadColumn, to: LeadColumn, o = { hasQuote: false, canReopen: false }) => leadMove(from, to, o);
    expect(ok("NEW", "CONTACTED")).toEqual({ ok: true, kind: "contact" });
    expect(ok("NEW", "QUOTED")).toEqual({ ok: true, kind: "quote-builder" });
    expect(ok("CONTACTED", "QUOTED", { hasQuote: true, canReopen: false })).toEqual({ ok: true, kind: "quote" });
    for (const from of ["NEW", "CONTACTED", "QUOTED"] as const) {
      expect(ok(from, "WON")).toEqual({ ok: true, kind: "convert" });
      expect(ok(from, "LOST")).toEqual({ ok: true, kind: "lost" });
    }
    expect(ok("LOST", "NEW", { hasQuote: false, canReopen: true })).toEqual({ ok: true, kind: "reopen" });
    expect(ok("LOST", "CONTACTED", { hasQuote: true, canReopen: true })).toEqual({ ok: true, kind: "reopen" });
    expect(ok("LOST", "NEW")).toEqual({ ok: false, why: REOPEN_NEEDS_MANAGER });
    expect(ok("LOST", "QUOTED", { hasQuote: true, canReopen: true }).ok).toBe(false);
    expect(ok("LOST", "WON", { hasQuote: true, canReopen: true }).ok).toBe(false);
    for (const to of LEAD_COLUMNS) if (to !== "WON") expect(ok("WON", to, { hasQuote: true, canReopen: true })).toEqual({ ok: false, why: WON_IS_FINAL });
    expect(ok("CONTACTED", "NEW").ok).toBe(false);
    expect(ok("QUOTED", "NEW").ok).toBe(false);
    expect(ok("QUOTED", "CONTACTED").ok).toBe(false);
    for (const s of LEAD_COLUMNS) expect(ok(s, s).ok).toBe(false);
    expect(leadMove("NEW", "WON", { hasQuote: false, canReopen: false, canConvert: false }).ok).toBe(false);
  });
});

describe("v6 §3 — moves on the server (LD-1, LD-4)", () => {
  it("LD-1/LD-4: New → Contacted moves at once, with the optional quick note on the timeline; audited with how it was moved", async () => {
    const l = await newLead();
    const r = await moveLead(w.actors.FRONT_DESK, l.id, { to: "CONTACTED", via: "drag", note: "Called — will visit on Saturday" });
    expect(r).toMatchObject({ from: "NEW", status: "CONTACTED" });
    expect(await status(l.id)).toBe("CONTACTED");
    const t = await timeline(l.id);
    expect(t.map((a) => [a.type, a.note])).toEqual(expect.arrayContaining([["STATUS_CHANGE", "Moved New → Contacted"], ["NOTE", "Called — will visit on Saturday"]]));
    const a = await moves(l.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actorId: w.actors.FRONT_DESK.userId, before: { status: "NEW" }, after: { status: "CONTACTED", kind: "contact", via: "drag" } });
    // Without a note (the quick-note dialog skipped): still moved and on the timeline.
    const m = await newLead("No Note Nina");
    await moveLead(w.actors.FRONT_DESK, m.id, { to: "CONTACTED", via: "menu" });
    expect((await timeline(m.id)).filter((x) => x.type === "NOTE" && !x.note.startsWith("Lead created"))).toHaveLength(0);
    expect((await moves(m.id))[0].after).toMatchObject({ via: "menu" });
  });

  it("LD-1: → Quoted without a quote is refused (the board opens the quote builder); creating the quote moves it and is audited", async () => {
    const l = await newLead();
    const refused = await http(moveLead(w.actors.FRONT_DESK, l.id, { to: "QUOTED" }));
    expect(refused).toMatchObject({ status: 409, code: "LEAD_MOVE_NOT_ALLOWED" });
    expect(refused.message).toMatch(/no quote yet/);
    expect(await status(l.id)).toBe("NEW");
    await createQuote(w.actors.FRONT_DESK, l.id, { lines: [{ planCode: "GOLD", months: 1 }] });
    expect(await status(l.id)).toBe("QUOTED");
    expect((await moves(l.id))[0]).toMatchObject({ before: { status: "NEW" }, after: { status: "QUOTED", kind: "quote-builder" } });
    expect((await timeline(l.id)).some((a) => a.type === "QUOTE_SENT")).toBe(true);
  });

  it("LD-1: → Quoted for a lead that already has a quote moves directly (reopened lead)", async () => {
    const l = await quotedLead();
    clock.advance(60_000);
    await moveLead(w.actors.FRONT_DESK, l.id, { to: "LOST", reason: "price too high" });
    clock.advance(60_000);
    await moveLead(w.actors.MANAGER, l.id, { to: "CONTACTED", reason: "Called back, wants a new offer" });
    clock.advance(60_000);
    await moveLead(w.actors.FRONT_DESK, l.id, { to: "QUOTED" });
    expect(await status(l.id)).toBe("QUOTED");
    expect((await moves(l.id)).map((a) => (a.after as { kind: string }).kind)).toEqual(["quote-builder", "lost", "reopen", "quote"]);
  });

  it("LD-1: → Won is refused as a move (CR-7: only paying the membership makes it WON); until then the lead shows Converting…", async () => {
    const l = await newLead("Convert Chetan");
    const refused = await http(moveLead(w.actors.FRONT_DESK, l.id, { to: "WON" }));
    expect(refused).toMatchObject({ status: 409, code: "LEAD_MOVE_NOT_ALLOWED" });
    expect(refused.message).toMatch(/Convert to member/);
    // "Convert to member": the member exists, the membership isn't paid → still NEW, flagged converting on the board.
    await createMember(w.actors.FRONT_DESK, { name: l.name, phone: l.phone!, dob: "1991-01-01", leadId: l.id, plan: { code: "SILVER", months: 1 } });
    expect(await status(l.id)).toBe("NEW");
    const row = (await listView(w.actors.MANAGER, "leads", {})).rows.find((r) => r.id === l.id) as { status: string; converting: boolean };
    expect(row).toMatchObject({ status: "NEW", converting: true });
    expect(await moves(l.id)).toHaveLength(0);
  });

  it("LD-1: → Lost needs a reason (refused without one, nothing changes); with one it is LOST, on the timeline and audited", async () => {
    const l = await newLead();
    expect(await http(moveLead(w.actors.FRONT_DESK, l.id, { to: "LOST" }))).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await http(moveLead(w.actors.FRONT_DESK, l.id, { to: "LOST", reason: "  " }))).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await status(l.id)).toBe("NEW");
    expect(await moves(l.id)).toHaveLength(0);
    await moveLead(w.actors.FRONT_DESK, l.id, { to: "LOST", reason: "joined another club", via: "drag" });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect([after.status, after.lostReason]).toEqual(["LOST", "joined another club"]);
    expect((await timeline(l.id)).some((a) => a.type === "STATUS_CHANGE" && a.note === "Marked lost: joined another club")).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityId: l.id, action: "lead.lost" } })).toBe(1);
    expect((await moves(l.id))[0]).toMatchObject({ reason: "joined another club", after: { status: "LOST", kind: "lost", via: "drag" } });
  });

  it("LD-1: Lost → New/Contacted ('Reopened') — by a Manager or the Owner with a reason OK; by the front desk FORBIDDEN", async () => {
    const l = await lostLead();
    expect(await http(moveLead(w.actors.FRONT_DESK, l.id, { to: "NEW", reason: "They called back" }))).toMatchObject({ status: 403, code: "FORBIDDEN", message: REOPEN_NEEDS_MANAGER });
    expect(await http(moveLead(w.actors.FRONT_DESK, l.id, { to: "CONTACTED", reason: "They called back" }))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await status(l.id)).toBe("LOST");
    expect(await http(moveLead(w.actors.MANAGER, l.id, { to: "NEW" }))).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    await moveLead(w.actors.MANAGER, l.id, { to: "NEW", reason: "They called back" });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect([after.status, after.lostReason]).toEqual(["NEW", null]);
    expect(after.nextFollowUpAt.getTime()).toBeGreaterThan(Date.parse("2026-10-12T04:30:00Z"));
    expect((await timeline(l.id)).some((a) => a.type === "STATUS_CHANGE" && a.note === "Reopened → New: They called back")).toBe(true);
    expect((await moves(l.id)).find((a) => (a.after as { kind: string }).kind === "reopen")).toMatchObject({ actorId: w.actors.MANAGER.userId, reason: "They called back", before: { status: "LOST" }, after: { status: "NEW", kind: "reopen" } });
    const o = await lostLead();
    await moveLead(w.actors.OWNER, o.id, { to: "CONTACTED", reason: "Owner knows them" });
    expect(await status(o.id)).toBe("CONTACTED");
    // Lost → Quoted / Won are not reopen moves.
    const q = await lostLead();
    expect(await http(moveLead(w.actors.MANAGER, q.id, { to: "QUOTED", reason: "x y z" }))).toMatchObject({ status: 409, code: "LEAD_MOVE_NOT_ALLOWED" });
    expect(await http(moveLead(w.actors.MANAGER, q.id, { to: "WON", reason: "x y z" }))).toMatchObject({ status: 409, code: "LEAD_MOVE_NOT_ALLOWED" });
  });

  it("LD-1: out of Won is never allowed (terminal) — for every column and every role", async () => {
    const l = await wonLead();
    for (const to of ["NEW", "CONTACTED", "QUOTED", "LOST"] as const) {
      for (const who of [w.actors.FRONT_DESK, w.actors.MANAGER, w.actors.OWNER]) {
        expect(await http(moveLead(who, l.id, { to, reason: "trying to undo" }))).toMatchObject({ status: 409, code: "LEAD_MOVE_NOT_ALLOWED", message: WON_IS_FINAL });
      }
    }
    expect(await status(l.id)).toBe("WON");
    expect(await moves(l.id)).toHaveLength(0);
  });

  it("LD-1: backwards moves, same column, unknown columns and other roles are refused; nothing changes", async () => {
    const c = await newLead("Back Bala");
    await logActivity(w.actors.FRONT_DESK, c.id, { type: "CALL", note: "Rang them" });
    expect(await status(c.id)).toBe("CONTACTED");
    expect(await http(moveLead(w.actors.MANAGER, c.id, { to: "NEW" }))).toMatchObject({ code: "LEAD_MOVE_NOT_ALLOWED" });
    expect(await http(moveLead(w.actors.FRONT_DESK, c.id, { to: "CONTACTED" }))).toMatchObject({ code: "LEAD_MOVE_NOT_ALLOWED" });
    const q = await quotedLead();
    expect(await http(moveLead(w.actors.OWNER, q.id, { to: "CONTACTED" }))).toMatchObject({ code: "LEAD_MOVE_NOT_ALLOWED" });
    expect(await http(moveLead(w.actors.OWNER, q.id, { to: "NEW" }))).toMatchObject({ code: "LEAD_MOVE_NOT_ALLOWED" });
    expect(moveSchema.safeParse({ to: "ARCHIVED" }).success).toBe(false);
    expect(await http(moveLead(w.actors.BAR_STAFF, q.id, { to: "LOST", reason: "not mine" }))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await http(moveLead(w.actors.FRONT_DESK, "nope", { to: "LOST", reason: "missing" }))).toMatchObject({ status: 404 });
    expect([await status(c.id), await status(q.id)]).toEqual(["CONTACTED", "QUOTED"]);
    expect((await moves(c.id)).length + (await moves(q.id)).length).toBe(1); // only q's quote-builder move
  });
});

describe("v6 §3 — the board's list keeps working (LD-3)", () => {
  it("LD-3: counts per column follow the moves; filters, assignee and the summary strip still apply; rows carry has_quote/converting", async () => {
    const a = await newLead("Count Asha");
    const b = await newLead("Count Bhavin");
    await newLead("Count Charu");
    await moveLead(w.actors.FRONT_DESK, a.id, { to: "CONTACTED" });
    await moveLead(w.actors.FRONT_DESK, b.id, { to: "LOST", reason: "no budget" });
    type Row = { id: string; status: string; has_quote: boolean; converting: boolean; overdue: boolean; assignee: string | null };
    const all = await listView(w.actors.MANAGER, "leads", { status: "NEW,CONTACTED,QUOTED,WON,LOST" });
    const rows = all.rows as Row[];
    const per = (s: string) => rows.filter((r) => r.status === s).length;
    expect([per("NEW"), per("CONTACTED"), per("LOST")]).toEqual([1, 1, 1]);
    expect(rows.every((r) => r.has_quote === false && r.converting === false)).toBe(true);
    // The default (open leads) drops the lost one; the status facet counts every column.
    const open = await listView(w.actors.MANAGER, "leads", {});
    expect(open.total).toBe(2);
    expect(open.facets.find((f) => f.key === "status")!.options.find((o) => o.value === "LOST")!.count).toBe(1);
    expect(open.summary.find((s) => s.key === "open")!.value).toBe(2);
    // The front desk's own view (assignee=me) and the overdue filter still work after moves.
    const mine = await listView(w.actors.FRONT_DESK, "leads", {});
    expect(mine.query).toMatchObject({ assignee: "me" });
    expect((await listView(w.actors.MANAGER, "leads", { status: "NEW,CONTACTED,QUOTED", overdue: "no" })).total).toBe(2);
    await createQuote(w.actors.FRONT_DESK, a.id, { lines: [{ planCode: "SILVER", months: 1 }] });
    const quoted = (await listView(w.actors.MANAGER, "leads", { status: "QUOTED" })).rows as Row[];
    expect(quoted.map((r) => [r.id, r.has_quote])).toEqual([[a.id, true]]);
  });
});

describe("v6 DESK-1 — the front desk sees every member on Check-in & Search Members", () => {
  it("DESK-1: the desk lists members (FilterBar facets, summary strip, search) through /api/lists/members; /app/members stays closed (RN-1)", async () => {
    await makeMember(w, { name: "Desk Gold Gauri", plan: "GOLD" });
    await makeMember(w, { name: "Desk Silver Suresh", plan: "SILVER" });
    await makeMember(w, { name: "Desk Pending Pooja", plan: "SILVER", pay: false });
    const r = await listView(w.actors.FRONT_DESK, "members", {});
    expect(r.total).toBe(3);
    expect(r.summary.map((s) => s.key)).toEqual(expect.arrayContaining(["active", "expiring", "dues", "new"]));
    expect(r.facets.map((f) => f.key)).toEqual(expect.arrayContaining(["tier", "status", "dues"]));
    const filtered = await listView(w.actors.FRONT_DESK, "members", { status: "PENDING_PAYMENT" });
    expect(filtered.rows.map((x) => (x as { name: string }).name)).toEqual(["Desk Pending Pooja"]);
    expect((await listView(w.actors.FRONT_DESK, "members", { q: "Gauri" })).total).toBe(1);
    // The page: Check-in & Search Members (on the desk's menu) is open; the Members page is not; the sidebar is unchanged.
    expect(canOpenPage("FRONT_DESK", "/app/desk")).toBe(true);
    expect(canOpenPage("FRONT_DESK", "/app/desk?status=PENDING_PAYMENT")).toBe(true);
    expect(canOpenPage("FRONT_DESK", "/app/members")).toBe(false);
    expect(canOpenPage("FRONT_DESK", "/app/members/abc")).toBe(true); // a row opens the member
    expect(navPaths("FRONT_DESK")).not.toContain("/app/members");
    // The bar and shop can't list members (members.view).
    await expect(listView(w.actors.BAR_STAFF, "members", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
