// Dev-only tools (E-25): time travel and "run all jobs now". Disabled when NODE_ENV=production.
import { z } from "zod";
import { clock } from "@/lib/clock";
import { withTx } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan } from "../rbac/permissions";
import { audit } from "./audit";
import { syncClockOffset } from "./settings";

function assertDev() {
  if (process.env.NODE_ENV === "production") throw new DomainError("FORBIDDEN", "Dev tools are disabled in production.");
}

export const offsetSchema = z.object({ offsetMs: z.number().int().min(-400 * 86_400_000).max(400 * 86_400_000) });

export async function setClockOffset(actor: Actor, raw: z.infer<typeof offsetSchema>) {
  assertDev();
  assertCan(actor, "dev_tools");
  const input = offsetSchema.parse(raw);
  await withTx(async (tx) => {
    await tx.setting.upsert({ where: { key: "dev_clock_offset_ms" }, create: { key: "dev_clock_offset_ms", value: input.offsetMs }, update: { value: input.offsetMs } });
    await audit(tx, actor, "dev.clock_offset", "setting", "dev_clock_offset_ms", { after: { offsetMs: input.offsetMs } });
  });
  await syncClockOffset(true);
  return { offsetMs: input.offsetMs, now: clock.now().toISOString() };
}

export async function runJobsNow(actor: Actor) {
  assertDev();
  assertCan(actor, "dev_tools");
  const { runAllJobs } = await import("../jobs");
  return runAllJobs();
}

export function devClockInfo() {
  return { now: clock.now().toISOString(), offsetMs: clock.getOffset(), production: process.env.NODE_ENV === "production" };
}
