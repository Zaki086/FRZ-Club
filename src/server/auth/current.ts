// Request-scoped actor for Next.js server components and route handlers.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { PUBLIC, type Actor, type UserActor } from "../rbac/actor";
import { syncClockOffset } from "../services/settings";
import { SESSION_COOKIE, actorFromToken } from "./sessions";

export async function currentActor(): Promise<Actor> {
  await syncClockOffset();
  const jar = await cookies();
  const actor = await actorFromToken(jar.get(SESSION_COOKIE)?.value);
  return actor ?? PUBLIC;
}

/** For pages: redirect to login when not signed in, or home when the role is not allowed. */
export async function requireUser(roles?: Role[], next?: string): Promise<UserActor> {
  const actor = await currentActor();
  if (actor.kind !== "USER") redirect(`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  if (roles && !roles.includes(actor.role)) redirect(actor.role === "MEMBER" ? "/portal" : "/app/forbidden");
  return actor;
}

export const STAFF_ROLES: Role[] = ["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT"];
