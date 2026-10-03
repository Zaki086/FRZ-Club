// First run (completion pass §4): an empty install has no club identity, no courts and no staff. `npm run
// create-owner` makes the Owner; the setup wizard (/setup) collects what the club really is and blocks /app until
// it is complete. Sample data (seed:demo) marks setup as done because its identity is the sample one.
import { isValidGstin } from "@/lib/codes";
import { clock } from "@/lib/clock";
import { prisma } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { getCapabilities } from "./capabilities";
import { getSettings, updateSetting } from "./settings";

export async function isSetupComplete(): Promise<boolean> {
  return !!(await getSettings()).setup_completed_at;
}

export type SetupStep = { key: string; label: string; done: boolean; required: boolean; detail: string };

export async function setupStatus(actor: Actor) {
  assertCan(actor, "settings");
  const s = await getSettings();
  const caps = await getCapabilities();
  const taxRow = await prisma.setting.findUnique({ where: { key: "tax_rates" } });
  const courts = await prisma.court.count({ where: { archivedAt: null, active: true } });
  const plans = await prisma.plan.count({ where: { active: true } });
  const club = s.club;
  const steps: SetupStep[] = [
    {
      key: "identity", label: "Club identity", required: true,
      done: !!(club.name.trim() && club.address.trim() && club.state.trim() && /^\d{2}$/.test(club.state_code)),
      detail: "Name, address and state appear on receipts and invoices.",
    },
    {
      key: "gst", label: "GST", required: true,
      done: !club.gstin || (isValidGstin(club.gstin) && !!taxRow?.verified),
      detail: !club.gstin ? "Not GST-registered: no GST is charged." : !isValidGstin(club.gstin) ? "The GSTIN is not valid." : taxRow?.verified ? "GST rates confirmed." : "Confirm the GST rates.",
    },
    {
      key: "payments", label: "Payments", required: false, done: true,
      detail: `Accepting: ${["payments.cash", "payments.card", "payments.upi", "payments.online"].filter((k) => caps[k as keyof typeof caps].enabled).map((k) => k.split(".")[1]).join(", ")}.`,
    },
    { key: "courts", label: "Courts", required: true, done: courts > 0, detail: courts ? `${courts} court(s).` : "Add at least one court." },
    { key: "plans", label: "Membership plans", required: true, done: plans > 0, detail: plans ? `${plans} plan(s) — check the prices.` : "No plans." },
  ];
  return { completedAt: s.setup_completed_at, sampleData: s.instance_mode === "SAMPLE_DATA", steps, ready: steps.every((x) => x.done || !x.required) };
}

export async function completeSetup(actor: Actor) {
  const st = await setupStatus(actor);
  const missing = st.steps.filter((x) => x.required && !x.done);
  if (missing.length) throw new DomainError("VALIDATION_FAILED", `Finish these steps first: ${missing.map((m) => `${m.label} (${m.detail})`).join("; ")}`);
  const at = clock.now().toISOString();
  await updateSetting(actor, "setup_completed_at", at);
  await audit(prisma, actor, "setup.complete", "setting", "setup_completed_at", { after: { at } });
  return { completedAt: at };
}
