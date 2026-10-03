// `ALLOW_DEMO_RESET=1 npm run demo:reset` — wipe a SAMPLE-DATA database and rebuild the sample club (completion pass §4).
// Refuses unless ALLOW_DEMO_RESET=1 is set AND the database is empty or marked instance_mode = SAMPLE_DATA, so it can
// never erase a real club.
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { SEED_LOCK_KEY } from "@/server/jobs";

async function main() {
  if (process.env.ALLOW_DEMO_RESET !== "1") throw new Error("demo:reset erases the database. Set ALLOW_DEMO_RESET=1 to confirm.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const [{ exists }] = await prisma.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('public.settings') IS NOT NULL AS exists`;
  if (exists) {
    const users = await prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM users`;
    const mode = await prisma.$queryRaw<{ v: unknown }[]>`SELECT value AS v FROM settings WHERE key = 'instance_mode'`;
    if (Number(users[0].c) > 0 && mode[0]?.v !== "SAMPLE_DATA") {
      await prisma.$disconnect();
      throw new Error("This database holds real club data (instance_mode is not SAMPLE_DATA). demo:reset refuses to erase it.");
    }
  }
  // Hold the seed lock from the drop to the end of the seed so the worker never runs jobs on a half-built database.
  const [{ got }] = await prisma.$queryRaw<{ got: boolean }[]>`SELECT pg_try_advisory_lock(${SEED_LOCK_KEY}::bigint) AS got`;
  if (!got) throw new Error("A seed is already running on this database.");
  await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
  await prisma.$executeRawUnsafe("CREATE SCHEMA public");
  try {
    execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
    execSync("npx tsx prisma/seed/index.ts", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url, SEED_LOCK_HELD: "1" } });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
