import type { Role } from "@prisma/client";

/** Who is performing a service call (plan §1.1 rule 4). */
export type UserActor = {
  kind: "USER";
  userId: string;
  role: Role;
  name: string;
  memberId: string | null;
  employeeId: string | null;
};
export type SystemActor = { kind: "SYSTEM"; name: string };
export type PublicActor = { kind: "PUBLIC" };
export type Actor = UserActor | SystemActor | PublicActor;

export const SYSTEM: SystemActor = { kind: "SYSTEM", name: "system" };
export const PUBLIC: PublicActor = { kind: "PUBLIC" };

export function actorId(a: Actor): string | null {
  return a.kind === "USER" ? a.userId : null;
}

export function actorLabel(a: Actor): string {
  if (a.kind === "USER") return `${a.name} (${a.role})`;
  if (a.kind === "SYSTEM") return `system:${a.name}`;
  return "public website";
}

/** Key for idempotency records (unique per actor). */
export function actorKey(a: Actor): string {
  if (a.kind === "USER") return `user:${a.userId}`;
  if (a.kind === "SYSTEM") return `system:${a.name}`;
  return "public";
}

export function isStaff(a: Actor): a is UserActor {
  return a.kind === "USER" && a.role !== "MEMBER";
}

export function isMember(a: Actor): a is UserActor & { memberId: string } {
  return a.kind === "USER" && a.role === "MEMBER" && !!a.memberId;
}
