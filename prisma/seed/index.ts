// `npm run seed` — builds the club and 60 days of history by calling the real services with the injected clock.
// It never inserts ledger, stock or booking rows directly (§11.2). It ends by running verify:integrity (§9).
import { clock } from "@/lib/clock";
import { addDays, istDate, istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { runIntegrityChecks } from "@/server/services/integrity";
import { seedBase } from "./base";
import { seedCatalogue } from "./catalogue";
import { seedPersonas } from "./personas";
import { seedHistory, seedSummary } from "./history";

async function main() {
  const started = Date.now();
  process.env.BCRYPT_ROUNDS ??= "8";
  process.env.SEEDING = "1";
  const today = istDate(new Date());
  if ((await prisma.member.count()) > 0) {
    throw new Error("The database already has data. Run `npm run db:reset` first (dev only), then `npm run seed`.");
  }
  clock.set(istToUtc(addDays(today, -62), "09:00"));
  console.log("Seeding reference data (settings, plans, courts, staff)…");
  const staff = await seedBase(addDays(today, -400));
  console.log("Seeding catalogue, menu and tables…");
  await seedCatalogue(staff.shop, staff.manager);
  clock.set(istToUtc(addDays(today, -61), "09:30"));
  console.log("Seeding demo personas (Rahul Gold, Neha Silver, Aarav Junior 15)…");
  const personas = await seedPersonas(staff.desk, addDays(today, -61));
  console.log("Simulating 60 days of club life through the services…");
  const h = await seedHistory(staff, today, personas);
  clock.set(null);
  console.log(`\nSeed summary (${h.members} members):`);
  for (const [k, v] of seedSummary()) console.log(`  ${k.padEnd(48)} ${v}`);
  console.log("\nRunning verify:integrity…");
  const checks = await runIntegrityChecks();
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  #${c.id} ${c.name}\n      ${c.detail}`);
  console.log(`\nSeed finished in ${Math.round((Date.now() - started) / 1000)} s.`);
  await prisma.$disconnect();
  if (checks.some((c) => !c.ok)) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
