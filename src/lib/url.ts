// URL-1: the one place absolute links are built. Every message, email, push payload, QR code, quote/refund/resolution/
// set-password/share link, invoice, sitemap and Open Graph tag goes through `absoluteUrl` so the only public address
// that ever leaves the app is `APP_URL` (never a request Host header, a tunnel or an old IP:port).

/** The configured public origin (`APP_URL` without a trailing slash; empty when unset). */
export function publicOrigin(): string {
  const raw = (process.env.APP_URL ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/** A host that can only be a temporary/internal address of this club: a quick tunnel, localhost or a bare IP. */
export function isStaleHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "trycloudflare.com" ||
    host.endsWith(".trycloudflare.com") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(":")
  );
}

/**
 * URL-1: an absolute link on the club's public address.
 * - `"/portal"` → `"<APP_URL>/portal"`; a path without a leading slash gets one.
 * - an already-absolute URL on the APP_URL host name is re-based onto `publicOrigin()` (so a scheme/port variant is
 *   normalised).
 * - an absolute URL on a stale origin (a `*.trycloudflare.com` tunnel, localhost or a bare IP:port) keeps only its
 *   path/query/hash and is moved onto APP_URL — a stale address is never passed through.
 * - any other absolute http(s) URL (e.g. a club logo on a CDN) is returned unchanged.
 */
export function absoluteUrl(path: string): string {
  const origin = publicOrigin();
  let rest = path ?? "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    let u: URL;
    try {
      u = new URL(rest);
    } catch {
      return rest;
    }
    // Our own public name on any scheme/port counts as ours (e.g. the plain-http twin of the HTTPS address).
    const own = origin && (() => { try { return new URL(origin).hostname === u.hostname; } catch { return false; } })();
    if (!own && !isStaleHost(u.hostname)) return rest;
    rest = `${u.pathname}${u.search}${u.hash}`;
  }
  if (rest === "" || rest === "/") return origin ? `${origin}/` : "/";
  if (!rest.startsWith("/") && !rest.startsWith("?") && !rest.startsWith("#")) rest = `/${rest}`;
  return `${origin}${rest}`;
}

/** The host (with port) of APP_URL — for ids like iCal UIDs that need a stable club-specific domain. */
export function publicHost(): string {
  const origin = publicOrigin();
  try {
    return origin ? new URL(origin).host : "";
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
}

export type AppUrlProblem = "MISSING" | "NOT_HTTPS" | "TUNNEL" | "LOCALHOST" | "BARE_IP" | "INVALID";

/** URL-2: why `APP_URL` is unfit for production (null when it is fine). */
export function appUrlProblem(value: string | undefined): AppUrlProblem | null {
  const raw = (value ?? "").trim();
  if (!raw) return "MISSING";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "INVALID";
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "trycloudflare.com" || host.endsWith(".trycloudflare.com")) return "TUNNEL";
  if (host === "localhost" || host.endsWith(".localhost")) return "LOCALHOST";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return "BARE_IP";
  if (u.protocol !== "https:") return "NOT_HTTPS";
  return null;
}

const PROBLEM_TEXT: Record<AppUrlProblem, string> = {
  MISSING: "APP_URL is not set",
  INVALID: "APP_URL is not a valid URL",
  NOT_HTTPS: "APP_URL must start with https://",
  TUNNEL: "APP_URL points at a temporary trycloudflare.com tunnel",
  LOCALHOST: "APP_URL points at localhost",
  BARE_IP: "APP_URL is a bare IP address",
};

export const appUrlProblemText = (p: AppUrlProblem) => PROBLEM_TEXT[p];

/**
 * URL-2: the production boot check. Throws (refusing to start) when APP_URL is unfit, unless this is a test run
 * (NODE_ENV=test / VITEST) or the explicit escape hatch `ALLOW_INSECURE_APP_URL=1` is set (the e2e test club runs
 * `next start` on http://localhost).
 */
export function assertPublicAppUrl(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (env.VITEST || env.ALLOW_INSECURE_APP_URL === "1") return;
  const problem = appUrlProblem(env.APP_URL);
  if (problem) {
    throw new Error(
      `URL-2: refusing to start — ${appUrlProblemText(problem)} (APP_URL=${JSON.stringify(env.APP_URL ?? "")}). ` +
        "Set APP_URL to the club's public https:// address (set ALLOW_INSECURE_APP_URL=1 only for local test runs).",
    );
  }
}
