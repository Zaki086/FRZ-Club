import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { route } from "@/server/http";
import { SESSION_COOKIE, logout } from "@/server/auth/sessions";

export const POST = route(
  async () => {
    const jar = await cookies();
    await logout(jar.get(SESSION_COOKIE)?.value);
    jar.delete(SESSION_COOKIE);
    return NextResponse.json({ data: { ok: true } });
  },
  { auth: "optional" },
);
