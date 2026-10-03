// Drop and recreate the dev database schema, then apply all migrations. Dev only.
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("db:reset is disabled in production");
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
  await prisma.$executeRawUnsafe("CREATE SCHEMA public");
  await prisma.$disconnect();
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
  console.log("Database reset and migrated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
