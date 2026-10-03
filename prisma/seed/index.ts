// `npm run seed:demo` — builds a SAMPLE club and 60 days of history by calling the real services with the injected
// clock. It never inserts ledger, stock or booking rows directly (§11.2). It ends by running verify:integrity (§9).
// It refuses to run on a database that already holds data (completion pass §4): a real club never gets sample rows.
import { clock } from "@/lib/clock";
import { addDays, istDate, istToUtc } from "@/lib/time";
import { prisma } from "@/server/db";
import { runIntegrityChecks } from "@/server/services/integrity";
import { SEED_LOCK_KEY } from "@/server/jobs";
import { getSettings } from "@/server/services/settings";
import { finishSampleSettings, seedBase } from "./base";
import { seedCatalogue } from "./catalogue";
import { seedPersonas } from "./personas";
import { closeDrawers, openDrawers, seedHistory, seedSummary } from "./history";

async function main() {
  const started = Date.now();
  process.env.BCRYPT_ROUNDS ??= "8";
  process.env.SEEDING = "1";
  const today = istDate(new Date());
  // Hold the seed lock for the whole run: the worker skips its real-clock jobs meanwhile (session lock, released
  // when this process exits).
  if (!process.env.SEED_LOCK_HELD) {
    const [{ got }] = await prisma.$queryRaw<{ got: boolean }[]>`SELECT pg_try_advisory_lock(${SEED_LOCK_KEY}::bigint) AS got`;
    if (!got) throw new Error("Another seed is already running on this database.");
  }
  const users = await prisma.user.count();
  if (users > 0) {
    const mode = (await getSettings()).instance_mode;
    throw new Error(
      mode === "SAMPLE_DATA"
        ? "This database already holds the sample data. To rebuild it run `ALLOW_DEMO_RESET=1 npm run demo:reset`."
        : `This database holds real club data (${users} user accounts). seed:demo only runs on an empty database and never adds sample rows to a real club.`,
    );
  }
  clock.set(istToUtc(addDays(today, -62), "09:00"));
  console.log("Seeding reference data (settings, plans, courts, staff)…");
  const staff = await seedBase(addDays(today, -400));
  console.log("Seeding catalogue, menu and tables…");
  await seedCatalogue(staff.shop, staff.manager);
  clock.set(istToUtc(addDays(today, -61), "09:30"));
  console.log("Seeding demo personas (Rahul Gold, Neha Silver, Aarav Junior 15)…");
  await openDrawers(staff);
  const personas = await seedPersonas(staff.desk, addDays(today, -61));
  await closeDrawers(staff, false);
  console.log("Simulating 60 days of club life through the services…");
  const h = await seedHistory(staff, today, personas);
  clock.set(null);
  await finishSampleSettings();
  console.log(`\nSeed summary (${h.members} members):`);
  for (const [k, v] of seedSummary()) console.log(`  ${k.padEnd(48)} ${v}`);
  console.log("\nRunning verify:integrity…");
  const checks = await runIntegrityChecks();
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  #${c.id} ${c.name}\n      ${c.detail}`);
  console.log("\nSample data is marked SAMPLE_DATA: every page shows a banner until the database is reset.");
  console.log("Logins use SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD from .env.");
  console.log(`\nSeed finished in ${Math.round((Date.now() - started) / 1000)} s.`);
  await prisma.$disconnect();
  if (checks.some((c) => !c.ok)) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
