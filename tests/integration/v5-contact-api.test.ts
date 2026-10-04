// v5 §2.2/§2.3 — every inventoried endpoint that takes a phone or email rejects an invalid one with 422
// VALIDATION_FAILED naming the field (CV-8), on the route's own pipeline (`body(req, schema)` → errorResponse) and in the
// service (the server is authoritative even when the route schema is bypassed); duplicates on create are
// PHONE_ALREADY_REGISTERED / EMAIL_ALREADY_REGISTERED, naming the member code to staff only (CV-6).
import type { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";
import { prisma } from "@/server/db";
import { body, errorResponse } from "@/server/http";
import { PUBLIC } from "@/server/rbac/actor";
import { CONTACT_PHONE_MESSAGE, EMAIL_MESSAGE, LOGIN_IDENTIFIER_MESSAGE, MOBILE_MESSAGE } from "@/lib/validation/contact";
import { forgotPassword, forgotSchema, loginIdentifierField, profileSchema, updateProfile } from "@/server/auth/account";
import { login } from "@/server/auth/sessions";
import { createMember, createMemberSchema, updateMember, updateMemberSchema } from "@/server/services/membership";
import { createEnquiry, createLead, createTrialBooking, leadSchema, publicFormSchema, trialSchema } from "@/server/services/crm";
import { createStaff, createStaffSchema } from "@/server/services/users";
import { clientSchema, createClient } from "@/server/services/invoices";
import { getSettings, updateSetting } from "@/server/services/settings";
import { openTab, openTabSchema } from "@/server/services/bar";
import { createBooking, createBookingSchema, paymentChoiceSchema, playerInputSchema } from "@/server/services/booking";
import { joinSession } from "@/server/services/social";
import { checkout, checkoutSchema, counterSale, counterSaleSchema } from "@/server/services/shop";
import { payOutRefund, payOutSchema } from "@/server/services/refunds";
import { sendTestEmail, testEmailSchema, whatsappLink, whatsappSchema } from "@/server/services/messages";
import { sendWhatsappTest, whatsappTestSchema } from "@/server/services/channels";
import { sendWhatsappTestMessage, whatsappTestMessageSchema } from "@/server/services/whatsapp/setup";
import { makeWorld, TEST_CLUB, TEST_PASSWORD, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";

let w: World;
beforeAll(async () => {
  w = await makeWorld();
});

type Rejection = { status: number; code: string; message: string; details: Record<string, unknown> | null };

async function rejection(p: Promise<unknown> | (() => unknown)): Promise<Rejection> {
  let err: unknown = null;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err, "expected the call to be rejected").toBeTruthy();
  const res = errorResponse(err);
  const j = (await res.json()) as { error: { code: string; message: string; details: Record<string, unknown> | null } };
  return { status: res.status, ...j.error };
}

/** The route's own pipeline: `body(req, schema)` with the JSON the browser would send, mapped by errorResponse. */
function viaRoute(schema: ZodType, json: unknown) {
  return rejection(() => body({ json: async () => json } as unknown as NextRequest, schema));
}

function expect422(r: Rejection, field: string, message: string) {
  expect(r.status).toBe(422);
  expect(r.code).toBe("VALIDATION_FAILED");
  expect(r.message).toContain(`${field}: ${message}`);
}

const MEMBER = { name: "Valid Vikas", dob: "1990-01-01" };

describe("v5 CV-8 — invalid phone / email → 422 with the field name, per endpoint", () => {
  it("POST /api/auth/login — identifier (mobile, email or member code)", async () => {
    const loginSchema = z.object({ identifier: loginIdentifierField, password: z.string().min(1) });
    expect422(await viaRoute(loginSchema, { identifier: "98110", password: "x" }), "identifier", LOGIN_IDENTIFIER_MESSAGE);
    expect422(await viaRoute(loginSchema, { identifier: "owner@club", password: "x" }), "identifier", LOGIN_IDENTIFIER_MESSAGE);
    // A valid mobile in any format still logs in (normalised), and so does an email in capitals.
    expect(loginSchema.parse({ identifier: "+91 90000 00001", password: "x" }).identifier).toBe("9000000001");
    await expect(login(loginSchema.parse({ identifier: "+91 90000 00001", password: TEST_PASSWORD }).identifier, TEST_PASSWORD)).resolves.toMatchObject({ user: { role: "OWNER" } });
    await expect(login(loginSchema.parse({ identifier: "OWNER@Test.Club", password: "x" }).identifier, TEST_PASSWORD)).resolves.toMatchObject({ user: { role: "OWNER" } });
  });

  it("POST /api/auth/login — member-code login still works (v3 WK-2)", async () => {
    const m = await makeMember(w, { name: "Code Login", password: "member123" });
    const id = z.object({ identifier: loginIdentifierField }).parse({ identifier: m.memberCode.toLowerCase() }).identifier;
    await expect(login(id, "member123")).resolves.toMatchObject({ user: { role: "MEMBER" } });
  });

  it("POST /api/auth/forgot — identifier", async () => {
    expect422(await viaRoute(forgotSchema, { identifier: "not-an-id" }), "identifier", LOGIN_IDENTIFIER_MESSAGE);
    expect422(await rejection(forgotPassword({ identifier: "12@3" })), "identifier", LOGIN_IDENTIFIER_MESSAGE);
  });

  it("PUT /api/account — email and emergency contact mobile", async () => {
    const m = await makeMember(w, { name: "Account Asha" });
    expect422(await viaRoute(profileSchema, { email: "asha@" }), "email", EMAIL_MESSAGE);
    expect422(await rejection(updateProfile(m.actor, { email: "asha at mail.com" })), "email", EMAIL_MESSAGE);
    expect422(await rejection(updateProfile(m.actor, { emergencyContactPhone: "12345" })), "emergencyContactPhone", MOBILE_MESSAGE);
    const ok = await updateProfile(m.actor, { email: " Asha.Account@Mail.COM ", emergencyContactPhone: "+91 98200 00011" });
    expect(ok.email).toBe("asha.account@mail.com");
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.memberId } })).emergencyContactPhone).toBe("9820000011");
  });

  it("POST /api/members — mobile, email, emergency phone, guardian mobile", async () => {
    const desk = w.actors.FRONT_DESK;
    expect422(await viaRoute(createMemberSchema, { ...MEMBER, phone: "5811000001" }), "phone", MOBILE_MESSAGE);
    expect422(await viaRoute(createMemberSchema, { ...MEMBER, phone: "9811200001", email: "vikas@mail" }), "email", EMAIL_MESSAGE);
    expect422(await rejection(createMember(desk, { ...MEMBER, phone: "9811200001", emergencyContactPhone: "022" })), "emergencyContactPhone", MOBILE_MESSAGE);
    expect422(await rejection(createMember(desk, { ...MEMBER, dob: "2014-01-01", phone: "9811200001", guardianName: "Parent", guardianPhone: "1234567890" })), "guardianPhone", MOBILE_MESSAGE);
    // Valid input in any format is stored canonical.
    const r = await createMember(desk, { ...MEMBER, phone: "+91 98112-00001", email: "Vikas.Valid@Mail.com", emergencyContactPhone: "098200 00012" });
    const m = await prisma.member.findUniqueOrThrow({ where: { id: r.memberId } });
    expect([m.phone, m.email, m.emergencyContactPhone]).toEqual(["9811200001", "vikas.valid@mail.com", "9820000012"]);
  });

  it("PATCH /api/members/[id] — email and emergency phone", async () => {
    const m = await makeMember(w, { name: "Patch Priya" });
    expect422(await viaRoute(updateMemberSchema, { email: "priya@@mail.com" }), "email", EMAIL_MESSAGE);
    expect422(await rejection(updateMember(w.actors.FRONT_DESK, m.memberId, { emergencyContactPhone: "99999" })), "emergencyContactPhone", MOBILE_MESSAGE);
    const ok = await updateMember(w.actors.FRONT_DESK, m.memberId, { email: "", emergencyContactPhone: "" });
    expect([ok.email, ok.emergencyContactPhone]).toEqual([null, null]);
  });

  it("POST /api/crm/leads — mobile and email", async () => {
    expect422(await viaRoute(leadSchema, { name: "Lead Lata", phone: "98765" }), "phone", MOBILE_MESSAGE);
    expect422(await rejection(createLead(w.actors.FRONT_DESK, { name: "Lead Lata", email: "lata@x" })), "email", EMAIL_MESSAGE);
    const lead = await createLead(w.actors.FRONT_DESK, { name: "Lead Lata", phone: "(+91) 99887 76655", email: "LATA@Mail.in" });
    expect([lead.phone, lead.email]).toEqual(["9988776655", "lata@mail.in"]);
  });

  it("POST /api/enquiry — mobile and email (public)", async () => {
    const enquiry = leadSchema.extend(publicFormSchema.shape);
    expect422(await viaRoute(enquiry, { consent: true, name: "Public Pooja", phone: "+1 415 555 0100" }), "phone", MOBILE_MESSAGE);
    expect422(await rejection(createEnquiry({ consent: true, name: "Public Pooja", email: "pooja.mail.com" })), "email", EMAIL_MESSAGE);
  });

  it("POST /api/trial — mobile and email (public)", async () => {
    const trial = { consent: true as const, name: "Trial Tara", courtId: w.courts["Court 1"].id, date: "2026-10-14", startTime: "14:00" };
    expect422(await viaRoute(trialSchema, { ...trial, phone: "9999999" }), "phone", MOBILE_MESSAGE);
    expect422(await rejection(createTrialBooking({ ...trial, phone: "9811200101", email: "tara@" })), "email", EMAIL_MESSAGE);
  });

  it("POST /api/users — staff mobile and email", async () => {
    const staff = { name: "New Nita", role: "FRONT_DESK" as const, password: "password123", monthlySalary: 100, joinDate: "2026-01-01" };
    expect422(await viaRoute(createStaffSchema, { ...staff, phone: "0123456789" }), "phone", MOBILE_MESSAGE);
    expect422(await rejection(createStaff(w.actors.OWNER, { ...staff, phone: "9811200201", email: "nita@club" })), "email", EMAIL_MESSAGE);
  });

  it("POST /api/clients — business contact phone (mobile or STD landline) and email", async () => {
    const client = { name: "Acme Corp", address: "1 Ring Road, Vadodara", contactName: "Rakesh" };
    expect422(await viaRoute(clientSchema, { ...client, contactPhone: "011 2345 6789" }), "contactPhone", CONTACT_PHONE_MESSAGE);
    expect422(await rejection(createClient(w.actors.ACCOUNTANT, { ...client, contactEmail: "rakesh@acme" })), "contactEmail", EMAIL_MESSAGE);
    const c = await createClient(w.actors.ACCOUNTANT, { ...client, contactPhone: "0265 222 3333", contactEmail: "Rakesh@Acme.IN" });
    expect([c.contactPhone, c.contactEmail]).toEqual(["2652223333", "rakesh@acme.in"]);
  });

  it("PUT /api/settings/club — club phone and email (setup wizard + Settings → Club)", async () => {
    expect422(await rejection(updateSetting(w.actors.OWNER, "club", { ...TEST_CLUB, phone: "12345" })), "phone", CONTACT_PHONE_MESSAGE);
    expect422(await rejection(updateSetting(w.actors.OWNER, "club", { ...TEST_CLUB, email: "club@" })), "email", EMAIL_MESSAGE);
    await updateSetting(w.actors.OWNER, "club", { ...(await getSettings()).club, phone: "+91 265 222 3333", email: "Hello@Club.IN" });
    const club = (await getSettings()).club;
    expect([club.phone, club.email]).toEqual(["2652223333", "hello@club.in"]);
    await updateSetting(w.actors.OWNER, "club", { ...club, phone: "", email: "" }); // blank stays allowed until set up
  });

  it("POST /api/bar/tabs — guest mobile", async () => {
    expect422(await viaRoute(openTabSchema, { guest: { name: "Bar Guest", phone: "12" } }), "guest.phone", MOBILE_MESSAGE);
    expect422(await rejection(openTab(w.actors.BAR_STAFF, { guest: { name: "Bar Guest", phone: "abc" } })), "guest.phone", MOBILE_MESSAGE);
  });

  it("POST /api/bookings — a guest player's mobile and email", async () => {
    const b = { courtId: w.courts["Court 2"].id, date: "2026-10-13", startTime: "10:00", channel: "FRONT_DESK", payment: { kind: "LATER" } };
    expect422(await viaRoute(createBookingSchema, { ...b, players: [{ guest: { name: "Guest Gita", phone: "98110" } }] }), "players.0.guest.phone", MOBILE_MESSAGE);
    expect422(await rejection(createBooking(w.actors.FRONT_DESK, { ...b, channel: "FRONT_DESK", payment: { kind: "LATER" }, players: [{ guest: { name: "Guest Gita", email: "gita@" } }] })), "players.0.guest.email", EMAIL_MESSAGE);
  });

  it("POST /api/social/[id]/join — a guest player's mobile", async () => {
    const schema = z.object({ player: playerInputSchema, payment: paymentChoiceSchema.optional() });
    expect422(await viaRoute(schema, { player: { guest: { name: "Social Sam", phone: "55555" } } }), "player.guest.phone", MOBILE_MESSAGE);
    expect422(await rejection(joinSession(w.actors.FRONT_DESK, { sessionId: "none", player: { guest: { name: "Social Sam", phone: "55555" } } })), "player.guest.phone", MOBILE_MESSAGE);
  });

  it("POST /api/shop/counter-sale — walk-in mobile", async () => {
    const sale = { items: [{ variantId: "v", qty: 1 }], payments: [{ method: "CASH" }] };
    expect422(await viaRoute(counterSaleSchema, { ...sale, customerPhone: "98-76" }), "customerPhone", MOBILE_MESSAGE);
    expect422(await rejection(counterSale(w.actors.SHOP_STAFF, { ...sale, payments: [{ method: "CASH" as const }], customerPhone: "98-76" })), "customerPhone", MOBILE_MESSAGE);
  });

  it("POST /api/shop/checkout — guest mobile and email (public)", async () => {
    const order = { items: [{ variantId: "v", qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" };
    expect422(await viaRoute(checkoutSchema, { ...order, guest: { name: "Shop Shreya", phone: "12345 67890" } }), "guest.phone", MOBILE_MESSAGE);
    expect422(await rejection(checkout(PUBLIC, { ...order, fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP", guest: { name: "Shop Shreya", phone: "9811200301", email: "shreya@shop" } })), "guest.email", EMAIL_MESSAGE);
  });

  it("POST /api/refunds/[id]/pay-out — guest identification mobile", async () => {
    expect422(await viaRoute(payOutSchema, { method: "CASH", identityChecked: true, guestPhone: "123" }), "guestPhone", MOBILE_MESSAGE);
    expect422(await rejection(payOutRefund(w.actors.FRONT_DESK, "none", { method: "CASH", identityChecked: true, guestPhone: "98765-4321" })), "guestPhone", MOBILE_MESSAGE);
  });

  it("POST /api/messages/whatsapp — a custom message's mobile", async () => {
    expect422(await viaRoute(whatsappSchema, { template: "CUSTOM", phone: "1234567890", text: "Hello there" }), "phone", MOBILE_MESSAGE);
    expect422(await rejection(whatsappLink(w.actors.FRONT_DESK, { template: "CUSTOM", phone: "+44 7911 123456", text: "Hello there" })), "phone", MOBILE_MESSAGE);
  });

  it("POST /api/messages/test-email — SMTP test address", async () => {
    expect422(await viaRoute(testEmailSchema, { to: "owner@" }), "to", EMAIL_MESSAGE);
    expect422(await rejection(sendTestEmail(w.actors.OWNER, { to: "owner at club" })), "to", EMAIL_MESSAGE);
  });

  it("POST /api/messages/test-whatsapp and /api/whatsapp/test — WhatsApp test number", async () => {
    expect422(await viaRoute(whatsappTestSchema, { to: "12345" }), "to", MOBILE_MESSAGE);
    expect422(await viaRoute(whatsappTestMessageSchema, { to: "12345 67890" }), "to", MOBILE_MESSAGE);
    expect422(await rejection(sendWhatsappTest(w.actors.OWNER, { to: "12345" })), "to", MOBILE_MESSAGE);
    expect422(await rejection(sendWhatsappTestMessage(w.actors.OWNER, { to: "12345 67890" })), "to", MOBILE_MESSAGE);
  });
});

describe("v5 CV-6 — duplicates on create", () => {
  it("PHONE_ALREADY_REGISTERED names the existing member code to staff", async () => {
    const a = await makeMember(w, { name: "First Farah" });
    const r = await rejection(createMember(w.actors.FRONT_DESK, { ...MEMBER, phone: `+91 ${a.member.phone}` }));
    expect(r.code).toBe("PHONE_ALREADY_REGISTERED");
    expect(r.status).toBe(409);
    expect(r.message).toContain(a.memberCode);
    expect(r.details).toMatchObject({ field: "phone", memberCode: a.memberCode });
  });

  it("EMAIL_ALREADY_REGISTERED is case-insensitive and names the member to staff", async () => {
    const a = await makeMember(w, { name: "Mail Meera", email: "meera.mail@club.in" });
    const r = await rejection(createMember(w.actors.FRONT_DESK, { ...MEMBER, phone: "9811200401", email: "Meera.Mail@Club.IN" }));
    expect(r.code).toBe("EMAIL_ALREADY_REGISTERED");
    expect(r.message).toContain(a.memberCode);
  });

  it("staff user creation: a member's phone or a staff email is already registered", async () => {
    const a = await makeMember(w, { name: "Member Mohan" });
    const staff = { name: "Clash Kiran", role: "BAR_STAFF" as const, password: "password123", monthlySalary: 100, joinDate: "2026-01-01" };
    const p = await rejection(createStaff(w.actors.OWNER, { ...staff, phone: a.member.phone }));
    expect([p.code, p.details?.memberCode]).toEqual(["PHONE_ALREADY_REGISTERED", a.memberCode]);
    const e = await rejection(createStaff(w.actors.OWNER, { ...staff, phone: "9811200501", email: "OWNER@test.club" }));
    expect(e.code).toBe("EMAIL_ALREADY_REGISTERED");
    expect(e.message).toContain("a staff account");
  });

  it("an edit (member's own profile) keeps VALIDATION_FAILED; the member only hears 'already registered'", async () => {
    const a = await makeMember(w, { name: "Taken Tina", email: "tina.taken@club.in" });
    const b = await makeMember(w, { name: "Other Omar" });
    const r = await rejection(updateProfile(b.actor, { email: "TINA.TAKEN@club.in" }));
    expect(r.code).toBe("VALIDATION_FAILED");
    expect(r.message).toBe("This email address is already registered.");
    expect(r.message).not.toContain(a.memberCode);
    expect(r.details).toEqual({ field: "email", reason: "EMAIL_ALREADY_REGISTERED" });
  });

  it("staff editing a member's email to another member's is refused naming the member", async () => {
    const a = await makeMember(w, { name: "Owner Of Mail", email: "owned@club.in" });
    const b = await makeMember(w, { name: "Editing Ed" });
    const r = await rejection(updateMember(w.actors.FRONT_DESK, b.memberId, { email: "Owned@Club.in" }));
    expect([r.code, r.details?.reason, r.details?.memberCode]).toEqual(["VALIDATION_FAILED", "EMAIL_ALREADY_REGISTERED", a.memberCode]);
    expect(r.message).toContain(a.memberCode);
    // Keeping your own email is not a clash.
    await expect(updateMember(w.actors.FRONT_DESK, a.memberId, { email: "OWNED@club.in" })).resolves.toMatchObject({ email: "owned@club.in" });
  });

  it("migration 0018: users.email is unique ignoring case (users_email_lower_key)", async () => {
    const idx = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'users_email_lower_key'`;
    expect(idx[0].n).toBe(1);
    await expect(prisma.user.create({ data: { name: "Case Clash", phone: "9811200999", email: "OWNER@TEST.CLUB", role: "MANAGER" } })).rejects.toThrow(/Unique constraint|users_email_lower_key/);
  });
});
