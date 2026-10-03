// v3 §1 (fixed HTTPS address on its own port): plain HTTP on the public name goes to HTTPS; everything else passes.
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const APP = "https://champions.38-49-215-124.sslip.io:3443";
const saved = process.env.APP_URL;
afterEach(() => {
  process.env.APP_URL = saved;
});

function req(url: string, headers: Record<string, string>) {
  return new NextRequest(url, { headers });
}

describe("HTTPS redirect on the public name", () => {
  it("plain HTTP to the public name on the app's port → 308 to the HTTPS address, path and query kept", () => {
    process.env.APP_URL = APP;
    const r = proxy(req("http://champions.38-49-215-124.sslip.io:3200/portal?x=1", { host: "champions.38-49-215-124.sslip.io:3200", "x-forwarded-proto": "http" }));
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(`${APP}/portal?x=1`);
  });

  it("HTTPS through the front door, the bare IP and localhost are never redirected", () => {
    process.env.APP_URL = APP;
    const ok = [
      proxy(req("http://127.0.0.1:3200/login", { host: "champions.38-49-215-124.sslip.io:3443", "x-forwarded-host": "champions.38-49-215-124.sslip.io:3443", "x-forwarded-proto": "https" })),
      proxy(req("http://38.49.215.124:3200/login", { host: "38.49.215.124:3200", "x-forwarded-proto": "http" })),
      proxy(req("http://localhost:3200/login", { host: "localhost:3200", "x-forwarded-proto": "http" })),
    ];
    for (const r of ok) expect(r.status).toBe(200);
  });

  it("without an HTTPS APP_URL nothing is redirected", () => {
    process.env.APP_URL = "http://38.49.215.124:3200";
    const r = proxy(req("http://champions.38-49-215-124.sslip.io:3200/login", { host: "champions.38-49-215-124.sslip.io:3200", "x-forwarded-proto": "http" }));
    expect(r.status).toBe(200);
  });
});
