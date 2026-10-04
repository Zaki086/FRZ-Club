// `npm run create-owner -- --name "Full Name" --phone 98XXXXXXXX [--email owner@club.in]`
// First run (completion pass §4): creates the one Owner login on an empty install. The password is read from
// OWNER_PASSWORD or typed at the prompt (never passed on the command line, so it stays out of shell history).
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { istDate } from "@/lib/time";
import { prisma } from "@/server/db";
import { SYSTEM } from "@/server/rbac/actor";
import { ensureDefaultSettings } from "@/server/services/settings";
import { ensurePlans } from "@/server/services/plans";
import { createStaff } from "@/server/services/users";
import { absoluteUrl, publicOrigin } from "@/lib/url";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readPassword(): Promise<string> {
  if (process.env.OWNER_PASSWORD) return process.env.OWNER_PASSWORD;
  if (!stdin.isTTY) throw new Error("Set OWNER_PASSWORD or run this in a terminal to type the password.");
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Hide what is typed.
  const out = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted || s.includes("\n")) stdout.write(muted ? "\n" : s);
  };
  const ask = async (q: string) => {
    stdout.write(q);
    muted = true;
    const v = await rl.question("");
    muted = false;
    return v;
  };
  const a = await ask("Owner password (8+ characters): ");
  const b = await ask("Repeat the password: ");
  rl.close();
  if (a !== b) throw new Error("The passwords don't match.");
  return a;
}

async function main() {
  const name = arg("name")?.trim();
  const phone = arg("phone")?.trim();
  const email = arg("email")?.trim() || undefined;
  if (!name || !phone) throw new Error('Usage: npm run create-owner -- --name "Full Name" --phone 98XXXXXXXX [--email owner@club.in]');
  const owners = await prisma.user.count({ where: { role: "OWNER" } });
  if (owners > 0) throw new Error("An Owner already exists. Add other staff from Settings → Users & roles.");
  const password = await readPassword();
  if (password.length < 8) throw new Error("The password must be at least 8 characters.");
  await ensureDefaultSettings();
  await ensurePlans();
  await createStaff(SYSTEM, { name, phone, email, role: "OWNER", password, monthlySalary: 0, joinDate: istDate(new Date()) });
  console.log(`Owner ${name} created. Log in at ${publicOrigin() ? absoluteUrl("/login") : "http://localhost:3200/login"} with ${email ?? phone} — the setup wizard opens first.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
