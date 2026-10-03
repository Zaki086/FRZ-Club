import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { route } from "@/server/http";
import { logoutEverywhere } from "@/server/auth/account";
import { SESSION_COOKIE } from "@/server/auth/sessions";

export const POST = route(async ({ actor }) => {
  await logoutEverywhere(actor);
  (await cookies()).delete(SESSION_COOKIE);
  return NextResponse.json({ data: { ok: true } });
});
