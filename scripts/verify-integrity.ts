// `npm run verify:integrity` — §9 checks against the database in DATABASE_URL. Exit code 1 on any failure.
import { runIntegrityChecks } from "@/server/services/integrity";
import { prisma } from "@/server/db";

async function main() {
  const checks = await runIntegrityChecks();
  console.log("\nThe Champions Club — data integrity (§9)\n");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  #${c.id} ${c.name}\n      ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  await prisma.$disconnect();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
