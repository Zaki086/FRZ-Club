// `npm run messages:repair-links [-- --apply] [-- --origin https://old.example:1234 ...]` — v6 URL-4.
// Replaces old addresses of this club (a `*.trycloudflare.com` quick tunnel, `http(s)://<ip>:<port>`, localhost, the
// public name on another scheme/port, sslip.io/nip.io names, and any `--origin` given) in stored, still-pending message
// text with APP_URL, and reports counts per table / column / old origin.
// Dry run by default (read-only transaction — safe on the live club). `--apply` writes, one audit row per changed row
// (action message.links_repaired). The logic lives in src/server/services/link-repair.ts.
import { prisma } from "@/server/db";
import { formatRepairReport, repairMessageLinks } from "@/server/services/link-repair";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const extraOrigins: string[] = [];
  args.forEach((a, i) => {
    if (a === "--origin" && args[i + 1]) extraOrigins.push(args[i + 1]);
    else if (a.startsWith("--origin=")) extraOrigins.push(a.slice("--origin=".length));
  });
  const report = await repairMessageLinks({ apply, extraOrigins });
  console.log(formatRepairReport(report));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
