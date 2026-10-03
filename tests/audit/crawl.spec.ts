// `npm run audit:dummy` (completion pass §10), part 2: every role visits every page it can reach from its menu, on a
// desktop and on a 360 px phone, and we record what a person would notice: error pages, console errors, dummy text,
// and pages wider than the phone. Results go to AUDIT_OUT (JSON); scripts/audit-dummy.ts writes AUDIT.md.
// v4 §1.4: the staff roles crawl their navigation lists (`_nav.ts`: the §1.1 lists for the Owner, Manager and Front
// desk) — every menu page is visited, and a rendered sidebar that differs from the list is reported.
import { writeFileSync } from "node:fs";
import type { Role } from "@prisma/client";
import { test, type Browser, type Page } from "@playwright/test";
import { navFor, type StaffRole } from "@/app/(staff)/app/_nav";

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PW = process.env.SEED_MEMBER_PASSWORD ?? "";
const STAFF_NAV = "aside a[href^='/'], nav a[href^='/']";
const ROLES: Array<{ role: string; login?: string; password?: string; nav: string; staff?: StaffRole }> = [
  { role: "public", nav: "header nav a[href^='/'], footer a[href^='/']" },
  { role: "member", login: "9811000001", password: MEMBER_PW, nav: "a[href^='/portal']" },
  { role: "owner", login: "owner@championsclub.example", password: STAFF_PW, nav: STAFF_NAV, staff: "OWNER" },
  { role: "manager", login: "manager@championsclub.example", password: STAFF_PW, nav: STAFF_NAV, staff: "MANAGER" },
  { role: "front desk", login: "desk@championsclub.example", password: STAFF_PW, nav: STAFF_NAV, staff: "FRONT_DESK" },
  { role: "shop", login: "shop@championsclub.example", password: STAFF_PW, nav: STAFF_NAV, staff: "SHOP_STAFF" },
  { role: "bar", login: "bar@championsclub.example", password: STAFF_PW, nav: STAFF_NAV, staff: "BAR_STAFF" },
  { role: "kitchen", login: "kitchen@championsclub.example", password: STAFF_PW, nav: STAFF_NAV, staff: "KITCHEN" },
  { role: "accountant", login: "accounts@championsclub.example", password: STAFF_PW, nav: STAFF_NAV, staff: "ACCOUNTANT" },
];

/** The role's navigation list (the same `navFor` the staff layout renders; dev tools are never on a menu). */
function menuOf(role: StaffRole): string[] {
  const actor = { kind: "USER" as const, userId: "audit", role: role as Role, name: role, memberId: null, employeeId: null };
  return navFor(actor, { devTools: false }).flatMap((g) => g.items.map((i) => i.href));
}
// Text a person should never see on a real screen.
const DUMMY = /lorem ipsum|\bundefined\b|\bNaN\b|\[object Object\]|\bTODO\b|\bFIXME\b|\bdummy\b|test mode|test gateway|placeholder text/i;
// Pages that are not ordinary screens (camera, downloads, print) are visited but not judged on width.
const SKIP_WIDTH = /^\/kiosk|^\/print\//;

type Result = { role: string; path: string; viewport: string; status: number; consoleErrors: string[]; dummyText: string | null; overflowPx: number; menuMismatch?: string | null };
const results: Result[] = [];

async function newPage(browser: Browser, width: number, height: number) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  return { ctx, page: await ctx.newPage() };
}

async function signIn(page: Page, login: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(login);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/(app|portal)/);
}

test.describe.configure({ mode: "serial" });

for (const r of ROLES) {
  test(`crawl as ${r.role}`, async ({ browser }) => {
    test.setTimeout(20 * 60_000);
    const desk = await newPage(browser, 1280, 800);
    if (r.login) await signIn(desk.page, r.login, r.password!);
    else await desk.page.goto("/");
    const links = new Set<string>([r.login ? (r.role === "member" ? "/portal" : "/app") : "/"]);
    // v4 §1.4: staff crawl their navigation list first (in menu order), then anything else the page header links to.
    const expected = r.staff ? menuOf(r.staff) : [];
    for (const href of expected) links.add(href);
    const rendered = await desk.page.locator(r.nav).evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""));
    for (const href of rendered) {
      const path = href.split("#")[0];
      if (path.startsWith("/") && !path.startsWith("/api/") && path !== "/login") links.add(path);
    }
    if (r.staff) {
      const menu = await desk.page.locator("aside nav a").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""));
      const same = menu.length === expected.length && menu.every((h, i) => h === expected[i]);
      results.push({
        role: r.role, path: "(sidebar)", viewport: "desktop", status: 200, consoleErrors: [], dummyText: null, overflowPx: 0,
        menuMismatch: same ? null : `rendered [${menu.join(", ")}] but the navigation list is [${expected.join(", ")}]`,
      });
    }
    const phone = await newPage(browser, 360, 740);
    if (r.login) {
      await phone.ctx.addCookies(await desk.ctx.cookies());
    }
    for (const path of links) {
      for (const [label, s] of [["desktop", desk], ["360px", phone]] as const) {
        const errors: string[] = [];
        const onConsole = (m: import("@playwright/test").ConsoleMessage) => {
          if (m.type() === "error") errors.push(m.text().slice(0, 200));
        };
        const onError = (e: Error) => errors.push(`pageerror: ${e.message.slice(0, 200)}`);
        s.page.on("console", onConsole);
        s.page.on("pageerror", onError);
        const res = await s.page.goto(path, { waitUntil: "networkidle" }).catch(() => null);
        await s.page.waitForTimeout(300);
        const text = await s.page.locator("body").innerText().catch(() => "");
        const m = DUMMY.exec(text);
        const overflow = SKIP_WIDTH.test(path) ? 0 : await s.page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
        results.push({ role: r.role, path, viewport: label, status: res?.status() ?? 0, consoleErrors: errors.filter((e) => !/camera|NotAllowedError|NotFoundError: Requested device/i.test(e)), dummyText: m ? text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, " ") : null, overflowPx: overflow });
        s.page.off("console", onConsole);
        s.page.off("pageerror", onError);
      }
    }
    await desk.ctx.close();
    await phone.ctx.close();
  });
}

test.afterAll(() => {
  writeFileSync(process.env.AUDIT_OUT ?? "audit-crawl.json", JSON.stringify(results, null, 2));
});
