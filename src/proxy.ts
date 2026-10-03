// v3 §1: a visitor who reaches the public HTTPS address over plain HTTP is sent to HTTPS (308). Only requests for
// that public host are redirected: the app's own port (the fallback while the HTTPS address is a quick tunnel) and
// local requests are left alone. Next sets X-Forwarded-Proto itself, so the host is what decides.
// v3 §6.1: every request also carries its own path (x-cc-path) so a page that finds the session gone can send the
// visitor to /login?returnTo=<that path>.
import { NextResponse, type NextRequest } from "next/server";

export const PATH_HEADER = "x-cc-path";

function pass(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export function proxy(request: NextRequest) {
  const appUrl = process.env.APP_URL ?? "";
  if (!appUrl.startsWith("https://")) return pass(request);
  const publicHost = new URL(appUrl).host;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const scheme = /"scheme":"(\w+)"/.exec(request.headers.get("cf-visitor") ?? "")?.[1] ?? request.headers.get("x-forwarded-proto");
  if (host !== publicHost || scheme !== "http") return pass(request);
  const url = new URL(request.nextUrl.pathname + request.nextUrl.search, appUrl);
  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
