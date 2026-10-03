// Thin route-handler wrapper (plan §1.1 rule 1): authenticate → validate (Zod) → service → map errors.
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z, ZodError, type ZodType } from "zod";
import { DomainError, httpStatusFor } from "./errors";
import { PUBLIC, type Actor } from "./rbac/actor";
import { SESSION_COOKIE, actorFromToken } from "./auth/sessions";
import { syncClockOffset } from "./services/settings";

export type RouteCtx<P> = { req: NextRequest; actor: Actor; params: P; idempotencyKey: string | null };

type Handler<P, T> = (ctx: RouteCtx<P>) => Promise<T>;

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof DomainError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, details: e.details ?? null } },
      { status: httpStatusFor(e.code) },
    );
  }
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: `Please check the form — ${where}${first?.message ?? "invalid input"}`,
          details: { issues: e.issues },
        },
      },
      { status: 422 },
    );
  }
  console.error("[api] unexpected error", e);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Something went wrong on the server. The error was logged.", details: null } },
    { status: 500 },
  );
}

export function route<P = Record<string, string>, T = unknown>(
  handler: Handler<P, T>,
  opts: { auth?: "required" | "optional" } = { auth: "required" },
) {
  return async (req: NextRequest, context: { params: Promise<P> }) => {
    try {
      await syncClockOffset();
      const jar = await cookies();
      const user = await actorFromToken(jar.get(SESSION_COOKIE)?.value);
      if (!user && (opts.auth ?? "required") === "required") {
        throw new DomainError("UNAUTHENTICATED", "Please log in.");
      }
      const params = context?.params ? await context.params : ({} as P);
      const result = await handler({
        req,
        actor: user ?? PUBLIC,
        params,
        idempotencyKey: req.headers.get("idempotency-key"),
      });
      if (result instanceof Response) return result;
      return NextResponse.json({ data: result ?? null });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<S extends ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new DomainError("VALIDATION_FAILED", "The request body must be valid JSON.");
  }
  return schema.parse(json);
}

export function query<S extends ZodType>(req: NextRequest, schema: S): z.infer<S> {
  const obj: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => (obj[k] = v));
  return schema.parse(obj);
}
