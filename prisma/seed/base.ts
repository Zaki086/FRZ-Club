// Reference data: settings, plans, courts, staff logins (one per role, §11.2) and the demo personas.
// Everything goes through the real services. This is SAMPLE DATA (completion pass §4): the instance is marked
// instance_mode = SAMPLE_DATA, every identity below is fictitious (example.com / .example addresses), and the
// passwords come from the environment — they are never written in the code or the README.
import type { Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { SYSTEM, type UserActor } from "@/server/rbac/actor";
import { DEFAULT_SETTINGS, ensureDefaultSettings, updateSetting, verifySetting } from "@/server/services/settings";
import { ensurePlans } from "@/server/services/plans";
import { createCourt } from "@/server/services/courts";
import { createStaff } from "@/server/services/users";

function envPassword(name: "SEED_STAFF_PASSWORD" | "SEED_MEMBER_PASSWORD"): string {
  const v = process.env[name] ?? "";
  if (v.length < 8) throw new Error(`${name} must be set (at least 8 characters) to create the sample logins. Put it in .env — it is not stored anywhere else.`);
  return v;
}
export const seedPasswords = () => ({ staff: envPassword("SEED_STAFF_PASSWORD"), member: envPassword("SEED_MEMBER_PASSWORD") });

/** Clearly fictitious sample identity: "ABCDE1234F" is the textbook example PAN; the check digit is valid. */
export const SAMPLE_CLUB = {
  ...DEFAULT_SETTINGS.club,
  name: "The Champions Club",
  state: "Gujarat",
  state_code: "24",
  legal_name: "Champions Sample Sports LLP",
  address: "Sample Address, Ahmedabad 380015",
  gstin: "24ABCDE1234F1Z6",
  phone: "",
  email: "",
};
export const SAMPLE_UPI_VPA = "sample.club@upi";
export const SAMPLE_PINCODES = ["380015", "380009", "380054", "380052", "380006"];

/** Sample-data settings: GST on with the sample GSTIN, card + UPI during the history (UPI is switched off at the end). */
export async function applySampleSettings() {
  await updateSetting(SYSTEM, "instance_mode", "SAMPLE_DATA");
  await updateSetting(SYSTEM, "setup_completed_at", new Date().toISOString()); // the sample identity needs no wizard
  await updateSetting(SYSTEM, "club", SAMPLE_CLUB);
  await verifySetting(SYSTEM, "tax_rates");
  await updateSetting(SYSTEM, "payment_methods", { card_enabled: true, upi_vpa: SAMPLE_UPI_VPA, upi_confirmed: true });
  await updateSetting(SYSTEM, "delivery", { enabled: true, pincodes: SAMPLE_PINCODES, fee: DEFAULT_SETTINGS.delivery.fee });
}

/** The sample UPI ID receives no real money, so UPI is not offered once the history is built (real or absent). */
export async function finishSampleSettings() {
  await updateSetting(SYSTEM, "payment_methods", { card_enabled: true, upi_vpa: "", upi_confirmed: false });
}

export const STAFF_LOGINS: Array<{ role: Exclude<Role, "MEMBER">; name: string; phone: string; email: string; salary: number }> = [
  { role: "OWNER", name: "Vikram Rao", phone: "9000000001", email: "owner@championsclub.example", salary: 0 },
  { role: "MANAGER", name: "Meera Iyer", phone: "9000000002", email: "manager@championsclub.example", salary: 6_500_000 },
  { role: "FRONT_DESK", name: "Farah Khan", phone: "9000000003", email: "desk@championsclub.example", salary: 2_800_000 },
  { role: "FRONT_DESK", name: "Dev Patel", phone: "9000000004", email: "desk2@championsclub.example", salary: 2_600_000 },
  { role: "SHOP_STAFF", name: "Sameer Joshi", phone: "9000000005", email: "shop@championsclub.example", salary: 2_500_000 },
  { role: "BAR_STAFF", name: "Bina Thomas", phone: "9000000006", email: "bar@championsclub.example", salary: 2_400_000 },
  { role: "BAR_STAFF", name: "Raju Nair", phone: "9000000007", email: "bar2@championsclub.example", salary: 2_200_000 },
  { role: "ACCOUNTANT", name: "Anita Desai", phone: "9000000008", email: "accounts@championsclub.example", salary: 4_500_000 },
  { role: "KITCHEN", name: "Suresh Kumar", phone: "9000000009", email: "kitchen@championsclub.example", salary: 2_000_000 },
];

export const COURTS: Array<{ name: string; sport: "TENNIS" | "CRICKET" }> = [
  { name: "Court 1", sport: "TENNIS" },
  { name: "Court 2", sport: "TENNIS" },
  { name: "Court 3", sport: "TENNIS" },
  { name: "Court 4", sport: "TENNIS" },
  { name: "Net A", sport: "CRICKET" },
  { name: "Net B", sport: "CRICKET" },
];

export type Staff = Record<string, UserActor>;

export async function seedBase(joinDate: string): Promise<Staff> {
  await ensureDefaultSettings();
  await applySampleSettings();
  await ensurePlans();
  const { staff: staffPassword } = seedPasswords();
  for (const [i, c] of COURTS.entries()) {
    if (!(await prisma.court.findUnique({ where: { name: c.name } }))) await createCourt(SYSTEM, { ...c, sortOrder: i });
  }
  const staff: Staff = {};
  for (const s of STAFF_LOGINS) {
    let user = await prisma.user.findUnique({ where: { phone: s.phone }, include: { employee: true } });
    if (!user) {
      await createStaff(SYSTEM, { name: s.name, phone: s.phone, email: s.email, role: s.role, password: staffPassword, monthlySalary: s.salary, joinDate });
      user = await prisma.user.findUniqueOrThrow({ where: { phone: s.phone }, include: { employee: true } });
    }
    staff[s.email.split("@")[0]] = { kind: "USER", userId: user.id, role: s.role, name: s.name, memberId: null, employeeId: user.employee?.id ?? null };
  }
  return staff;
}
