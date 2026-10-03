import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { body, route } from "@/server/http";
import { SESSION_COOKIE, login } from "@/server/auth/sessions";

const schema = z.object({ identifier: z.string().trim().min(3), password: z.string().min(1) });

export const POST = route(
  async ({ req }) => {
    const input = await body(req, schema);
    const s = await login(input.identifier, input.password);
    const jar = await cookies();
    jar.set(SESSION_COOKIE, s.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: s.expiresAt,
    });
    return NextResponse.json({ data: { user: s.user, home: s.user.role === "MEMBER" ? "/portal" : "/app" } });
  },
  { auth: "optional" },
);
