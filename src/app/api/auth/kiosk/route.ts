import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { route } from "@/server/http";
import { can } from "@/server/rbac/permissions";
import { SESSION_COOKIE, makeKioskSession } from "@/server/auth/sessions";

/** v3 §6.1: keep this tablet signed in as a kiosk for 90 days. */
export const POST = route(async ({ req, actor }) => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const r = await makeKioskSession(token, can(actor, "checkin"));
  const https = req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  jar.set(SESSION_COOKIE, token!, { httpOnly: true, secure: https, sameSite: "lax", path: "/", expires: r.expiresAt });
  return NextResponse.json({ data: { expiresAt: r.expiresAt } });
});
