import { prisma } from "@/server/db";

const CODE_SEQUENCES = [
  "member_code_seq",
  "booking_code_seq",
  "shop_order_code_seq",
  "counter_sale_code_seq",
  "tab_code_seq",
  "lead_code_seq",
  "service_ticket_code_seq",
];

/** Empty every table of the test database (TRUNCATE does not fire the no-delete row triggers). */
export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  for (const s of CODE_SEQUENCES) await prisma.$executeRawUnsafe(`ALTER SEQUENCE ${s} RESTART WITH 1`);
}
