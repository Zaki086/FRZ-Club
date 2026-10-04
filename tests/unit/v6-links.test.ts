// v6 §1 (LINKS): one helper builds every absolute link from APP_URL (URL-1); production refuses an unfit APP_URL
// (URL-2); the repair script's text rewriting (URL-4). Pure functions — no database.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { absoluteUrl, appUrlProblem, assertPublicAppUrl, publicHost, publicOrigin } from "@/lib/url";
import { absolute, pushPayload } from "@/server/services/channels";
import { absoluteUrl as recordsAbsoluteUrl, linkFor } from "@/server/services/messages/records";
import { setPasswordUrl } from "@/server/services/membership";
import { tableCardUrl } from "@/server/services/table-token";
import { isOldClubOrigin, repairText } from "@/server/services/link-repair";
import { register } from "@/instrumentation";

const APP = "https://club.example.in:3443";
const TUNNEL = "https://gentleman-promise-lottery-muslim.trycloudflare.com";
const saved = { ...process.env };
beforeEach(() => {
  process.env.APP_URL = APP;
});
afterEach(() => {
  for (const k of ["APP_URL", "NODE_ENV", "VITEST", "ALLOW_INSECURE_APP_URL"] as const) {
    if (saved[k] === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = saved[k];
  }
});

describe("URL-1 absoluteUrl / publicOrigin", () => {
  it("URL-1: builds links from APP_URL only (no trailing slash, paths with or without /)", () => {
    process.env.APP_URL = `${APP}/`;
    expect(publicOrigin()).toBe(APP);
    expect(publicHost()).toBe("club.example.in:3443");
    expect(absoluteUrl("/portal/membership")).toBe(`${APP}/portal/membership`);
    expect(absoluteUrl("portal")).toBe(`${APP}/portal`);
    expect(absoluteUrl("/")).toBe(`${APP}/`);
    expect(absoluteUrl("/quote/abc?x=1#y")).toBe(`${APP}/quote/abc?x=1#y`);
  });

  it("URL-1: an absolute URL on APP_URL is kept; a tunnel, IP:port or localhost origin is moved onto APP_URL", () => {
    expect(absoluteUrl(`${APP}/r/tok`)).toBe(`${APP}/r/tok`);
    expect(absoluteUrl(`${TUNNEL}/portal/membership`)).toBe(`${APP}/portal/membership`);
    expect(absoluteUrl("http://38.49.215.124:3200/rq/tok?a=1")).toBe(`${APP}/rq/tok?a=1`);
    expect(absoluteUrl("http://localhost:3200/portal")).toBe(`${APP}/portal`);
    expect(absoluteUrl("http://club.example.in/portal")).toBe(`${APP}/portal`); // same name, other scheme/port
    // Another site (e.g. a logo on a CDN) is not ours to rewrite.
    expect(absoluteUrl("https://cdn.example.com/logo.png")).toBe("https://cdn.example.com/logo.png");
  });

  it("URL-1: every builder routes through the helper (channels, records, set-password, table QR, push payload)", () => {
    expect(absolute("/portal/refunds?ref=RF-1")).toBe(`${APP}/portal/refunds?ref=RF-1`);
    expect(absolute(`${TUNNEL}/portal`)).toBe(`${APP}/portal`);
    expect(absolute(null)).toBe("");
    expect(recordsAbsoluteUrl("/orders/t1")).toBe(`${APP}/orders/t1`);
    expect(linkFor({ links: { "*": "/portal/tab" } } as never, null)).toBe(`${APP}/portal/tab`);
    expect(setPasswordUrl("tok")).toBe(`${APP}/set-password/tok`);
    expect(tableCardUrl("tbl_1").startsWith(`${APP}/t/TBL1.`)).toBe(true);
    const p = pushPayload({ event: "DUES_REMINDER", title: "t", body: "b", link: "/portal/invoices", dedupeKey: "k" });
    expect(p.payload.url).toBe(`${APP}/portal/invoices`);
    expect(pushPayload({ event: "DUES_REMINDER", title: "t", body: "b", link: null, dedupeKey: "k" }).payload.url).toBe(`${APP}/`);
  });
});

describe("URL-2 boot check", () => {
  it("URL-2: rejects a missing, plain-http, tunnel, localhost or bare-IP APP_URL; accepts the public https name", () => {
    expect(appUrlProblem(undefined)).toBe("MISSING");
    expect(appUrlProblem("")).toBe("MISSING");
    expect(appUrlProblem("not a url")).toBe("INVALID");
    expect(appUrlProblem("http://champions.38-49-215-124.sslip.io")).toBe("NOT_HTTPS");
    expect(appUrlProblem(TUNNEL)).toBe("TUNNEL");
    expect(appUrlProblem("https://localhost:3443")).toBe("LOCALHOST");
    expect(appUrlProblem("http://localhost:3201")).toBe("LOCALHOST");
    expect(appUrlProblem("https://38.49.215.124:3443")).toBe("BARE_IP");
    expect(appUrlProblem("https://[::1]:3443")).toBe("BARE_IP");
    expect(appUrlProblem("https://champions.38-49-215-124.sslip.io:3443")).toBeNull();
  });

  it("URL-2: production refuses to start; tests, dev and the explicit escape hatch are allowed", () => {
    const prod = { NODE_ENV: "production" };
    expect(() => assertPublicAppUrl({ ...prod, APP_URL: TUNNEL })).toThrow(/trycloudflare/);
    expect(() => assertPublicAppUrl({ ...prod, APP_URL: "http://localhost:3201" })).toThrow(/localhost/);
    expect(() => assertPublicAppUrl({ ...prod })).toThrow(/not set/);
    expect(() => assertPublicAppUrl({ ...prod, APP_URL: "https://champions.38-49-215-124.sslip.io:3443" })).not.toThrow();
    expect(() => assertPublicAppUrl({ ...prod, APP_URL: "http://localhost:3201", ALLOW_INSECURE_APP_URL: "1" })).not.toThrow();
    expect(() => assertPublicAppUrl({ ...prod, APP_URL: "http://localhost:3201", VITEST: "true" })).not.toThrow();
    expect(() => assertPublicAppUrl({ NODE_ENV: "test", APP_URL: "http://localhost:3200" })).not.toThrow();
    expect(() => assertPublicAppUrl({ NODE_ENV: "development" })).not.toThrow();
  });

  it("URL-2: instrumentation register() throws in production on a tunnel APP_URL", async () => {
    Object.assign(process.env, { NODE_ENV: "production", APP_SECRET: "x".repeat(40), APP_URL: TUNNEL });
    delete process.env.VITEST;
    delete process.env.ALLOW_INSECURE_APP_URL;
    await expect(register()).rejects.toThrow(/URL-2/);
    process.env.APP_URL = "https://champions.38-49-215-124.sslip.io:3443";
    await expect(register()).resolves.toBeUndefined();
  });
});

describe("URL-4 repair text", () => {
  it("URL-4: old club origins become APP_URL, paths kept; other sites untouched", () => {
    expect(isOldClubOrigin(TUNNEL, APP)).toBe(true);
    expect(isOldClubOrigin("http://38.49.215.124:3200", APP)).toBe(true);
    expect(isOldClubOrigin("http://club.example.in", APP)).toBe(true);
    expect(isOldClubOrigin("https://champions.38-49-215-124.nip.io", APP)).toBe(true);
    expect(isOldClubOrigin(APP, APP)).toBe(false);
    expect(isOldClubOrigin("https://wa.me", APP)).toBe(false);
    expect(isOldClubOrigin("https://old.example.org", APP)).toBe(false);
    expect(isOldClubOrigin("https://old.example.org", APP, ["https://old.example.org"])).toBe(true);
    const r = repairText(`Renew: ${TUNNEL}/portal/membership. Or http://38.49.215.124:3200. Chat https://wa.me/919800000000 · ${APP}/r/x`, APP);
    expect(r.text).toBe(`Renew: ${APP}/portal/membership. Or ${APP}. Chat https://wa.me/919800000000 · ${APP}/r/x`);
    expect(r.found).toEqual([TUNNEL, "http://38.49.215.124:3200"]);
  });
});
