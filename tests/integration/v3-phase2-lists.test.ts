// v3 phase 2 (§3): the list engine behind every FilterBar — server-side filters, facet counts, summary strip,
// defaults, CSV and saved views — on Members, Bookings and Leads.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { listExport, listView } from "@/server/services/filters";
import { deleteView, listSavedViews, saveView, MAX_SAVED_VIEWS } from "@/server/services/saved-views";
import { createLead } from "@/server/services/crm";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { book, guest } from "../helpers/booking";

let w: World;
type Facet = { key: string; options: Array<{ value: string; count: number }> };
const count = (facets: Facet[], key: string, value: string) => facets.find((f) => f.key === key)!.options.find((o) => o.value === value)?.count ?? 0;

beforeEach(async () => {
  w = await makeWorld();
});

describe("v3 §3 — Members list", () => {
  it("filters on the server with a count per option; counts ignore their own facet; the strip sums the filtered set", async () => {
    const gold = await makeMember(w, { name: "Gold Gita", plan: "GOLD" });
    await makeMember(w, { name: "Silver Sam", plan: "SILVER" });
    await makeMember(w, { name: "Pending Pia", plan: "SILVER", pay: false });
    await makeMember(w, { name: "Junior Jai", plan: "JUNIOR", dob: "2013-04-04" });
    let r = await listView(w.actors.FRONT_DESK, "members", {});
    expect(r.total).toBe(4);
    expect(count(r.facets, "status", "ACTIVE")).toBe(3);
    expect(count(r.facets, "status", "PENDING_PAYMENT")).toBe(1);
    expect(count(r.facets, "junior", "yes")).toBe(1);
    expect(count(r.facets, "guardian", "yes")).toBe(1);
    expect(r.summary.find((s) => s.key === "dues")!.value).toBe(200000); // the unpaid Silver plan
    r = await listView(w.actors.FRONT_DESK, "members", { tier: "GOLD,SILVER" });
    expect(r.rows.map((x) => x.name).sort()).toEqual(["Gold Gita", "Silver Sam"]);
    expect(count(r.facets, "tier", "JUNIOR")).toBe(1); // own facet ignored: you can still add Junior
    r = await listView(w.actors.FRONT_DESK, "members", { dues: "yes" });
    expect(r.rows.map((x) => x.name)).toEqual(["Pending Pia"]);
    r = await listView(w.actors.FRONT_DESK, "members", { q: gold.member.memberCode });
    expect(r.rows).toHaveLength(1);
    expect(r.summary.find((s) => s.key === "active")!.apply).toEqual({ status: "ACTIVE,EXPIRING" });
  });

  it("rejects unknown filters, values and page sizes; paginates", async () => {
    for (let i = 0; i < 3; i++) await makeMember(w, { name: `Pager ${i}`, plan: "SILVER" });
    await expect(listView(w.actors.FRONT_DESK, "members", { colour: "red" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(listView(w.actors.FRONT_DESK, "members", { tier: "PLATINUM" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(listView(w.actors.FRONT_DESK, "members", { size: "30" })).rejects.toThrow();
    const r = await listView(w.actors.FRONT_DESK, "members", { size: "25", page: "9" });
    expect([r.page, r.pages, r.rows.length]).toEqual([1, 1, 3]);
    await expect(listView(w.actors.BAR_STAFF, "members", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("exports the filtered rows as CSV only for roles that may export", async () => {
    await makeMember(w, { name: "Csv Chen", plan: "GOLD" });
    await expect(listExport(w.actors.FRONT_DESK, "members", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const csv = await listExport(w.actors.MANAGER, "members", { tier: "GOLD" });
    expect(csv.split("\n")[0]).toBe("Member code,Name,Mobile,Email,Tier,Membership,Ends,Dues (₹),Last visit,Joined");
    expect(csv).toContain("Csv Chen");
  });
});

describe("v3 §3 — Bookings list", () => {
  it("opens on today; a custom day, payment and court filters narrow it", async () => {
    await book(w, { time: "18:00", players: [guest("Today Tom")] });
    await book(w, { date: "2026-10-13", time: "18:00", players: [guest("Tomorrow Tia")] });
    let r = await listView(w.actors.FRONT_DESK, "bookings", {});
    expect(r.query.range).toBe("TODAY");
    expect(r.rows.map((x) => x.players)).toEqual(["Today Tom"]);
    expect(r.summary.find((s) => s.key === "due")!.value).toBe(40000);
    r = await listView(w.actors.FRONT_DESK, "bookings", { range: "CUSTOM", from: "2026-10-13", to: "2026-10-13" });
    expect(r.rows.map((x) => x.players)).toEqual(["Tomorrow Tia"]);
    r = await listView(w.actors.FRONT_DESK, "bookings", { range: "CUSTOM", from: "2026-10-12", to: "2026-10-13", payment: "PAID" });
    expect(r.total).toBe(0);
    expect(count(r.facets, "payment", "UNPAID")).toBe(2);
    r = await listView(w.actors.FRONT_DESK, "bookings", { range: "CUSTOM", from: "2026-10-12", to: "2026-10-13", court: w.courts["Court 1"].id, q: "Tia" });
    expect(r.total).toBe(1);
  });
});

describe("v3 §3 — Leads list", () => {
  it("front desk opens on their own open leads; 'Unassigned' and 'Me' are real options", async () => {
    await createLead(w.actors.FRONT_DESK, { name: "Lead Lina", phone: "9876500101", source: "WALK_IN" });
    const r = await listView(w.actors.FRONT_DESK, "leads", {});
    expect(r.query).toMatchObject({ status: "NEW,CONTACTED,QUOTED", assignee: "me" });
    const all = await listView(w.actors.MANAGER, "leads", {});
    expect(all.query.assignee).toBeUndefined();
    expect(all.total).toBe(1);
    const assignee = (await prisma.lead.findFirstOrThrow()).assignedTo;
    expect(count(all.facets, "assignee", assignee ?? "none")).toBe(1);
  });
});

describe("v3 §3 — saved views", () => {
  it("saves up to 10 per list (same name overwrites), only valid queries, only your own", async () => {
    const v = await saveView(w.actors.FRONT_DESK, { list: "members", name: "Dues", query: "dues=yes" });
    await saveView(w.actors.FRONT_DESK, { list: "members", name: "Dues", query: "dues=yes&tier=GOLD" });
    expect((await listSavedViews(w.actors.FRONT_DESK, "members")).map((x) => x.query)).toEqual(["dues=yes&tier=GOLD"]);
    await expect(saveView(w.actors.FRONT_DESK, { list: "members", name: "Bad", query: "colour=red" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    for (let i = 1; i < MAX_SAVED_VIEWS; i++) await saveView(w.actors.FRONT_DESK, { list: "members", name: `V${i}`, query: "" });
    await expect(saveView(w.actors.FRONT_DESK, { list: "members", name: "Eleventh", query: "" })).rejects.toThrow(/up to 10/);
    await expect(deleteView(w.actors.MANAGER, v.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await deleteView(w.actors.FRONT_DESK, v.id);
    expect(await listSavedViews(w.actors.FRONT_DESK, "members")).toHaveLength(MAX_SAVED_VIEWS - 1);
  });
});

describe("v3 §3 — the list engine", () => {
  it("every registered list runs, one after another and twice, on the same database connections", async () => {
    // Regression: lists used to share one temp-table name, and two lists whose row queries had the same text but
    // different columns failed with Postgres "cached plan must not change result type".
    const { LISTS } = await import("@/server/services/filters");
    const { SYSTEM } = await import("@/server/rbac/actor");
    for (let round = 0; round < 2; round++) {
      for (const name of Object.keys(LISTS)) {
        const r = await listView(SYSTEM, name, {});
        expect([name, Array.isArray(r.rows)]).toEqual([name, true]);
      }
    }
  });
});
