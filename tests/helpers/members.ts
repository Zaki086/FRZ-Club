import type { World } from "./world";
import { createMember } from "@/server/services/membership";
import type { UserActor } from "@/server/rbac/actor";
import { prisma } from "@/server/db";

let phoneSeq = 7000000000;

export async function makeMember(
  w: World,
  opts: { name: string; dob?: string; plan?: "GOLD" | "SILVER" | "JUNIOR"; months?: 1 | 3 | 12; pay?: boolean; email?: string; password?: string },
) {
  phoneSeq += 1;
  const r = await createMember(w.actors.FRONT_DESK, {
    name: opts.name,
    phone: String(phoneSeq),
    dob: opts.dob ?? "1990-05-05",
    email: opts.email,
    password: opts.password ?? "member123",
    plan: opts.plan
      ? { code: opts.plan, months: opts.months ?? 1, payment: opts.pay === false ? undefined : { method: "UPI", reference: "UTR" + phoneSeq } }
      : undefined,
  });
  const member = await prisma.member.findUniqueOrThrow({ where: { id: r.memberId } });
  const actor: UserActor = { kind: "USER", userId: member.userId!, role: "MEMBER", name: member.name, memberId: member.id, employeeId: null };
  return { ...r, member, actor };
}
