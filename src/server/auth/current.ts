// Request-scoped actor for Next.js server components and route handlers.
import { cookies, headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { PUBLIC, type Actor, type UserActor } from "../rbac/actor";
import { canOpenPage } from "../rbac/page-access";
import { syncClockOffset } from "../services/settings";
import { SESSION_COOKIE, actorFromToken } from "./sessions";

export async function currentActor(): Promise<Actor> {
  await syncClockOffset();
  const jar = await cookies();
  const actor = await actorFromToken(jar.get(SESSION_COOKIE)?.value);
  return actor ?? PUBLIC;
}

/** A same-site path only ("/x", never "//host" or a full URL), so returnTo can never send anyone off the site. */
export function safeReturnTo(p: string | null | undefined): string | null {
  return p && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\") ? p : null;
}

/**
 * For pages: redirect to login when not signed in, or home when the role is not allowed. v3 §6.1: the login link
 * carries `returnTo` (the page actually asked for, from the proxy; `next` is the fallback) and says when a session
 * ended rather than never existed.
 */
export async function requireUser(roles?: Role[], next?: string): Promise<UserActor> {
  const actor = await currentActor();
  if (actor.kind !== "USER") {
    const h = await headers();
    const returnTo = safeReturnTo(h.get("x-cc-path")) ?? safeReturnTo(next);
    const hadSession = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
    const q = new URLSearchParams();
    if (returnTo) q.set("returnTo", returnTo);
    if (hadSession) q.set("ended", "1");
    redirect(`/login${q.size ? `?${q.toString()}` : ""}`);
  }
  if (roles && !roles.includes(actor.role)) redirect(actor.role === "MEMBER" ? "/portal" : "/app/forbidden");
  // v4 RN-1: the Manager and Front desk open only their menu's pages and the detail pages reached from them (403
  // otherwise). Every staff page calls requireUser, and the proxy stamps each request (soft navigations too) with
  // its own path, so the rule holds for client-side navigation as well as full loads.
  const path = (await headers()).get("x-cc-path");
  if (path && !canOpenPage(actor.role, path)) forbidden();
  return actor;
}

export const STAFF_ROLES: Role[] = ["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT", "KITCHEN"];
