import { beforeAll, describe, expect, it } from "vitest";
import { login, actorFromToken } from "@/server/auth/sessions";
import { DomainError } from "@/server/errors";
import { assertCan, can } from "@/server/rbac/permissions";
import { PUBLIC } from "@/server/rbac/actor";
import { getSettings, updateSetting } from "@/server/services/settings";
import { listAudit } from "@/server/services/audit";
import { withTx, prisma } from "@/server/db";
import { idempotent } from "@/server/services/idempotency";
import { formatINR, inclusiveTax, percentOf, roundDiv } from "@/lib/money";
import { ageOn, financialYear, istDate, istToUtc, weekStart, addMonths } from "@/lib/time";
import { memberCardPayload, verifyMemberCardPayload } from "@/lib/qr";
import { isValidGstin } from "@/lib/codes";
import { makeWorld, TEST_PASSWORD, type World } from "../helpers/world";

let w: World;
beforeAll(async () => {
  w = await makeWorld();
});

describe("Phase 0 — auth & sessions", () => {
  it("every seeded staff role can log in and resolves to the right actor", async () => {
    for (const [role, actor] of Object.entries(w.actors)) {
      const s = await login(`${role.toLowerCase()}@test.club`, TEST_PASSWORD);
      const resolved = await actorFromToken(s.token);
      expect(resolved?.role).toBe(role);
      expect(resolved?.userId).toBe(actor.userId);
    }
  });

  it("wrong password is rejected with a human message", async () => {
    await expect(login("9000000001", "nope-nope")).rejects.toThrow(/Wrong phone\/email or password/);
  });
});

describe("Phase 0 — RBAC (§3) enforced in services", () => {
  it("RBAC: BAR_STAFF calling payroll / GST / settings is FORBIDDEN", async () => {
    const bar = w.actors.BAR_STAFF;
    for (const cap of ["payroll", "gst", "settings"] as const) {
      expect(() => assertCan(bar, cap)).toThrow(DomainError);
      try {
        assertCan(bar, cap);
      } catch (e) {
        expect((e as DomainError).code).toBe("FORBIDDEN");
      }
    }
    await expect(updateSetting(bar, "max_plays_per_day", 3)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("RBAC: matrix spot checks", () => {
    expect(can(w.actors.OWNER, "payroll")).toBe(true);
    expect(can(w.actors.ACCOUNTANT, "payroll")).toBe(true);
    expect(can(w.actors.MANAGER, "payroll")).toBe(false);
    expect(can(w.actors.MANAGER, "expenses.view")).toBe(true);
    expect(can(w.actors.MANAGER, "expenses.manage")).toBe(false);
    expect(can(w.actors.FRONT_DESK, "shop.counter")).toBe(true);
    expect(can(w.actors.FRONT_DESK, "shop.stock")).toBe(false);
    expect(can(w.actors.SHOP_STAFF, "bookings.any")).toBe(false);
    expect(can(w.actors.BAR_STAFF, "bar.void_after_prep")).toBe(false);
    expect(can(PUBLIC, "bookings.any")).toBe(false);
  });
});

describe("Phase 0 — settings & audit", () => {
  it("owner changes a setting; the change is validated and audited in the same transaction", async () => {
    await updateSetting(w.actors.OWNER, "max_plays_per_day", 3);
    expect((await getSettings()).max_plays_per_day).toBe(3);
    await expect(updateSetting(w.actors.OWNER, "max_plays_per_day", -1)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const logs = await listAudit(w.actors.OWNER, { entity: "setting", entityId: "max_plays_per_day" });
    expect(logs[0].action).toBe("settings.update");
    expect(logs[0].actorId).toBe(w.actors.OWNER.userId);
    await updateSetting(w.actors.OWNER, "max_plays_per_day", 2);
  });

  it("GST is charged only when the tax rates are verified AND the club GSTIN is valid (IN-6, completion pass §1)", async () => {
    expect((await getSettings()).gstEnabled).toBe(true);
    await prisma.setting.update({ where: { key: "tax_rates" }, data: { verified: false } });
    expect((await getSettings()).gstEnabled).toBe(false);
    await prisma.setting.update({ where: { key: "tax_rates" }, data: { verified: true } });
    const club = (await getSettings()).club;
    await updateSetting(w.actors.OWNER, "club", { ...club, gstin: "24AAACC1206D1ZA" }); // wrong check digit
    expect((await getSettings()).gstEnabled).toBe(false);
    await updateSetting(w.actors.OWNER, "club", club);
    expect((await getSettings()).gstEnabled).toBe(true);
  });

  it("audit rows and ledger rows are append-only at the database level", async () => {
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { reason: "x" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
});

describe("Phase 0 — idempotency (E-23)", () => {
  it("replaying a key returns the original result without running the work again", async () => {
    let runs = 0;
    const call = () =>
      withTx((tx) =>
        idempotent(tx, { key: "k-1", actorKey: "user:x", endpoint: "test", body: { a: 1 } }, async () => {
          runs++;
          return { value: runs };
        }),
      );
    const a = await call();
    const b = await call();
    expect(a).toEqual({ value: 1 });
    expect(b).toEqual({ value: 1 });
    expect(runs).toBe(1);
    await expect(
      withTx((tx) =>
        idempotent(tx, { key: "k-1", actorKey: "user:x", endpoint: "test", body: { a: 2 } }, async () => 1),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("parallel duplicates run the work exactly once", async () => {
    let runs = 0;
    const call = () =>
      withTx((tx) =>
        idempotent(tx, { key: "k-par", actorKey: "user:y", endpoint: "test", body: {} }, async () => {
          runs++;
          await new Promise((r) => setTimeout(r, 50));
          return { ok: true };
        }),
      );
    const results = await Promise.all(Array.from({ length: 5 }, call));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(runs).toBe(1);
  });
});

describe("Phase 0 — money & time utilities (§2)", () => {
  it("money: half-up rounding and GST-inclusive tax extraction", () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(percentOf(15000, 10)).toBe(1500);
    expect(percentOf(999, 15)).toBe(150); // 149.85 → 150
    expect(inclusiveTax(11800, 18)).toBe(1800);
    expect(inclusiveTax(10500, 5)).toBe(500);
    expect(formatINR(12345600)).toBe("₹1,23,456");
    expect(formatINR(55000)).toBe("₹550");
    expect(formatINR(12350)).toBe("₹123.50");
  });

  it("time: IST day boundaries, weeks, FY, age", () => {
    expect(istDate(new Date("2026-10-12T18:29:59Z"))).toBe("2026-10-12");
    expect(istDate(new Date("2026-10-12T18:30:00Z"))).toBe("2026-10-13");
    expect(istToUtc("2026-10-12", "18:00").toISOString()).toBe("2026-10-12T12:30:00.000Z");
    expect(weekStart("2026-10-18")).toBe("2026-10-12");
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    expect(financialYear("2026-03-31")).toBe("2025-26");
    expect(financialYear("2026-04-01")).toBe("2026-27");
    expect(ageOn("2008-10-13", "2026-10-12")).toBe(17);
    expect(ageOn("2008-10-12", "2026-10-12")).toBe(18);
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("MB-14: member card QR verifies, tampered QR does not", () => {
    const p = memberCardPayload("member123");
    expect(verifyMemberCardPayload(p)).toBe("member123");
    expect(verifyMemberCardPayload(p.replace("member123", "member124"))).toBeNull();
    expect(verifyMemberCardPayload("garbage")).toBeNull();
  });

  it("IN-1: GSTIN format validation", () => {
    expect(isValidGstin("24AABCC1234F1ZD")).toBe(true);
    expect(isValidGstin("24AABCC1234F1Z5")).toBe(false); // right shape, wrong check digit
    expect(isValidGstin("24AABCC1234F1XD")).toBe(false);
    expect(isValidGstin("99AABCC1234F1ZD")).toBe(false);
  });
});
