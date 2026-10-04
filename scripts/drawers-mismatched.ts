// `npm run drawers:mismatched` — v6 TL-3: list the open cash drawer sessions whose till is at a location the holder's
// role may not open (TL-1: front desk → front desk tills, shop staff → shop, bar staff → bar, accountant → office,
// Manager/Owner → any). READ-ONLY: it runs in a read-only transaction and closes nothing — a manager closes each
// session properly (count, close, then the person opens a till of their own area).
import { prisma } from "@/server/db";
import { mismatchedOpenSessions } from "@/server/services/drawers";
import { formatINR } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";

async function main() {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return mismatchedOpenSessions(tx);
  });
  console.log("\nThe Champions Club — open cash drawers at the wrong area (v6 TL-3, read-only)\n");
  if (!rows.length) console.log("None: every open drawer is at a till its holder's role may open.");
  for (const r of rows) {
    console.log(`- ${r.till} (${r.location}) open by ${r.user} [${r.role}] since ${fmtDateTime(r.openedAt)} — ${formatINR(r.cashExpected)} expected in it`);
    console.log(`    allowed for ${r.role}: ${r.allowed.join(", ") || "no till"} · close it at ${r.link}`);
  }
  console.log(`\n${rows.length} mismatched open session${rows.length === 1 ? "" : "s"}. Nothing was changed.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
