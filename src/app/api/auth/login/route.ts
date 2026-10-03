import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { body, route } from "@/server/http";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { SESSION_COOKIE, login } from "@/server/auth/sessions";

const schema = z.object({ identifier: z.string().trim().min(3), password: z.string().min(1) });

export const POST = route(
  async ({ req }) => {
    const input = await body(req, schema);
    // Generous per IP: a whole club may share one office connection; per-account lockout stops password guessing.
    rateLimit(`login:ip:${clientIp(req)}`, 60, 60_000, "Too many login attempts from this network. Please wait a minute.");
    const s = await login(input.identifier, input.password);
    const jar = await cookies();
    // Secure cookies are only stored by browsers over HTTPS; on plain HTTP (e.g. http://<server-ip>:3200) the
    // session must still work, so the flag follows the actual protocol (directly or via a proxy).
    const https = req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
    jar.set(SESSION_COOKIE, s.token, {
      httpOnly: true,
      secure: https,
      sameSite: "lax",
      path: "/",
      expires: s.expiresAt,
    });
    return NextResponse.json({ data: { user: s.user, home: s.home } });
  },
  { auth: "optional" },
);
