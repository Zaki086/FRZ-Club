import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/clock";
import { prisma } from "@/server/db";
import { createStaff } from "@/server/services/users";
import { clockIn } from "@/server/services/staff";
import { SYSTEM } from "@/server/rbac/actor";
import {
  createEnquiry, createLead, createQuote, createTrialBooking, flagOverdueLeads, getQuoteByToken, listLeads, logActivity, markInterested, markLost,
} from "@/server/services/crm";
import { createMember } from "@/server/services/membership";
import { getAvailability } from "@/server/services/booking";
import { makeWorld, type World, utr } from "../helpers/world";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
let desk2: Awaited<ReturnType<typeof createStaff>>;
beforeEach(async () => {
  w = await makeWorld();
  desk2 = await createStaff(SYSTEM, { name: "Second Desk", phone: "9000000099", email: "desk2@test.club", role: "FRONT_DESK", password: "password123", monthlySalary: 2_500_000, joinDate: "2025-01-01" });
});

describe("Phase 6 — enquiries can't vanish (CR-1…CR-5, R-36, E-17)", () => {
  it("R-36/CR-3: an enquiry becomes a lead, is spread across the desk on shift, notifies front desk + managers, follow-up in 24h", async () => {
    // v3 LA-2 replaces round robin (D-74): with both desks clocked in, the two leads go to different people.
    await clockIn(w.actors.FRONT_DESK);
    await clockIn({ kind: "USER", userId: desk2.user.id, role: "FRONT_DESK", name: "Second Desk", memberId: null, employeeId: desk2.employee.id });
    const a = await createEnquiry({ consent: true, name: "Stranger Sana", phone: "9876512345", email: "sana@example.com", interest: "Gold membership", message: "Do you have coaching?" });
    const b = await createEnquiry({ consent: true, name: "Second Sid", email: "sid@example.com" });
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: "asc" } });
    expect(leads.map((l) => l.code)).toEqual([a.leadCode, b.leadCode]);
    expect(leads[0].assignedTo).not.toBe(leads[1].assignedTo);
    expect(leads[0].nextFollowUpAt.getTime() - clock.now().getTime()).toBe(24 * 3600_000);
    const notified = await prisma.notification.findMany({ where: { type: "NEW_LEAD", title: { contains: "Stranger Sana" } }, include: { user: true } });
    expect(new Set(notified.map((n) => n.user.role))).toEqual(new Set(["FRONT_DESK", "MANAGER"]));
    expect(notified.length).toBe(3); // two front desk + manager
    await expect(createEnquiry({ consent: true, name: "No Contact" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("CR-4: leads are never deleted (database guard)", async () => {
    await createEnquiry({ consent: true, name: "Sticky Lead", phone: "9876512346" });
    const l = await prisma.lead.findFirstOrThrow();
    await expect(prisma.lead.delete({ where: { id: l.id } })).rejects.toThrow(/hard delete of leads is not allowed/);
  });

  it("CR-4/E-17: a missed follow-up is flagged OVERDUE and notified once; logging a call clears it (CONTACTED)", async () => {
    await createEnquiry({ consent: true, name: "Waiting Wasim", phone: "9876512347" });
    const lead = await prisma.lead.findFirstOrThrow();
    clock.advance(25 * 3600_000);
    expect((await flagOverdueLeads()).flagged).toBe(1);
    expect((await flagOverdueLeads()).flagged).toBe(0);
    expect((await listLeads(w.actors.FRONT_DESK)).find((l) => l.id === lead.id)!.overdue).toBe(true);
    const r = await logActivity(w.actors.FRONT_DESK, lead.id, { type: "CALL", note: "Called, interested in Silver" });
    expect(r.status).toBe("CONTACTED");
    expect((await listLeads(w.actors.FRONT_DESK)).find((l) => l.id === lead.id)!.overdue).toBe(false);
  });

  it("CR-2: LOST needs a reason; RBAC: bar staff can't see the CRM", async () => {
    const l = await createLead(w.actors.FRONT_DESK, { name: "Walk In Wally", phone: "9876512348", source: "WALK_IN" });
    await expect(markLost(w.actors.FRONT_DESK, l.id, "")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await markLost(w.actors.FRONT_DESK, l.id, "joined another club")).status).toBe("LOST");
    await expect(listLeads(w.actors.BAR_STAFF)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Phase 6 — quote and conversion (CR-6, CR-7, R-37)", () => {
  it("CR-6: a quote is priced from the plan, the lead becomes QUOTED, 'I'm interested' notifies the assignee once", async () => {
    await createEnquiry({ consent: true, name: "Quote Quinn", phone: "9876512349", email: "quinn@example.com" });
    const lead = await prisma.lead.findFirstOrThrow();
    const q = await createQuote(w.actors.FRONT_DESK, lead.id, { lines: [{ planCode: "SILVER", months: 3 }, { description: "Racket rental for the first month", amount: 50000 }], send: "EMAIL" });
    expect(q.total).toBe(540000 + 50000);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("QUOTED");
    expect(await prisma.emailOutbox.count({ where: { to: "quinn@example.com" } })).toBe(1);
    const page = await getQuoteByToken(q.token);
    expect([page.name, page.total, page.status]).toEqual(["Quote Quinn", 590000, "SENT"]);
    await markInterested(q.token);
    await markInterested(q.token);
    expect(await prisma.notification.count({ where: { type: "QUOTE_INTEREST", userId: lead.assignedTo! } })).toBe(1);
    clock.advance(8 * 86_400_000);
    expect((await getQuoteByToken(q.token)).expired).toBe(true);
  });

  it("CR-7: converting creates the member from the lead; when the membership is paid the lead is WON and linked", async () => {
    await createEnquiry({ consent: true, name: "Convert Kavya", phone: "9876512350" });
    const lead = await prisma.lead.findFirstOrThrow();
    const r = await createMember(w.actors.FRONT_DESK, {
      name: lead.name, phone: lead.phone!, dob: "1994-02-02", leadId: lead.id,
      plan: { code: "SILVER", months: 1, payment: { method: "UPI", reference: utr() } },
    });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect([after.status, after.memberId]).toEqual(["WON", r.memberId]);
    await expectIntegrity();
  });
});

describe("Phase 6 — trial bookings and public availability (CR-8, CR-9, R-34, R-35)", () => {
  it("CR-8: a visitor books a free trial (all BK rules apply) and a TRIAL_BOOKING lead appears; one trial per phone", async () => {
    const t = await createTrialBooking({ consent: true, name: "Trial Tanya", phone: "9876512351", email: "tanya@example.com", courtId: w.courts["Court 3"].id, date: "2026-10-12", startTime: "17:00" });
    expect(t.fee).toBe(0);
    const lead = await prisma.lead.findFirstOrThrow({ where: { source: "TRIAL_BOOKING" } });
    expect(lead.name).toBe("Trial Tanya");
    const booking = await prisma.booking.findFirstOrThrow({ where: { bookingCode: t.bookingCode } });
    expect(booking.channel).toBe("ONLINE_TRIAL");
    await expect(createTrialBooking({ consent: true, name: "Trial Tanya", phone: "+91 98765 12351", courtId: w.courts["Court 2"].id, date: "2026-10-13", startTime: "09:00" })).rejects.toMatchObject({ code: "TRIAL_ALREADY_USED" });
    await expect(createTrialBooking({ consent: true, name: "Clash", phone: "9876512352", courtId: w.courts["Court 3"].id, date: "2026-10-12", startTime: "17:30" })).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    await expect(createTrialBooking({ consent: true, name: "Far", phone: "9876512353", courtId: w.courts["Court 3"].id, date: "2026-10-15", startTime: "09:00" })).rejects.toMatchObject({ code: "OUTSIDE_BOOKING_WINDOW" });
    const pub = await getAvailability("PUBLIC", "2026-10-12", 7);
    expect(pub.dates).toHaveLength(7);
    expect(pub.dates[0].courts.find((c) => c.name === "Court 3")!.slots.find((s) => s.time === "17:00")!.label).toBe("Booked");
  });

  it("CR-8: an existing member's phone can't take a trial", async () => {
    await createMember(w.actors.FRONT_DESK, { name: "Already Member", phone: "9876512354", dob: "1990-01-01" });
    await expect(createTrialBooking({ consent: true, name: "Already Member", phone: "9876512354", courtId: w.courts["Court 1"].id, date: "2026-10-12", startTime: "17:00" })).rejects.toMatchObject({ code: "TRIAL_ALREADY_USED" });
  });
});
