import { expect } from "vitest";
import { runIntegrityChecks } from "@/server/services/integrity";

export async function expectIntegrity() {
  const checks = await runIntegrityChecks();
  const failed = checks.filter((c) => !c.ok);
  expect(failed, failed.map((f) => `#${f.id} ${f.name}: ${f.detail}`).join("\n")).toEqual([]);
}
