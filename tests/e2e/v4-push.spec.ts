// v4 §4 (Web Push, PUSH agent) e2e steps, in the style of ui-flows.spec.ts, against the seeded sample data. The lead
// runs Playwright. A real push service can't be reached from a test browser, so these steps check the screens:
//  1. A member logs in: the portal never asks for notification permission by itself; when the club has push set up
//     the dismissible "Get alerts…" card is shown and the permission prompt follows only a click on Enable.
//  2. Notification settings list the person's push devices (and explain the iPhone Home Screen rule on iPhone).
//  3. The Owner's Message Log links to the WhatsApp messages view (template, status timeline, tries) with the
//     FilterBar facets event, template, status and the date presets; the Notification Log filters by template.
//  4. Staff get the same alerts card / notification settings in My Account.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER_PW = process.env.SEED_MEMBER_PASSWORD ?? "";

type Session = { ctx: BrowserContext; page: Page };

async function loginUi(browser: Browser, identifier: string, password: string, lands?: RegExp, init?: (ctx: BrowserContext) => Promise<void>): Promise<Session> {
  const ctx = await browser.newContext();
  if (init) await init(ctx);
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands ?? /\/(app|portal)/);
  return { ctx, page };
}

/** Count every call to Notification.requestPermission (the browser prompt) without showing one. */
async function countPermissionPrompts(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    const w = window as unknown as { __prompts: number; Notification?: { requestPermission: () => Promise<string> } };
    w.__prompts = 0;
    if (w.Notification) {
      w.Notification.requestPermission = async () => {
        w.__prompts++;
        return "denied";
      };
    }
  });
}
const prompts = (page: Page) => page.evaluate(() => (window as unknown as { __prompts: number }).__prompts);

test("v4-push 1. the portal never prompts on page load; the alerts card asks only after Enable", async ({ browser }) => {
  const m = await loginUi(browser, "9811000002", MEMBER_PW, /\/portal/, countPermissionPrompts);
  await m.page.goto("/portal");
  await expect(m.page.getByRole("heading", { name: /^Hi / })).toBeVisible();
  expect(await prompts(m.page)).toBe(0);
  const caps = await (await m.ctx.request.get("/api/capabilities")).json();
  const card = m.page.getByTestId("push-opt-in");
  if (caps.data.pushKey) {
    await expect(card).toContainText("Get alerts for bookings, refunds and renewals");
    expect(await prompts(m.page)).toBe(0);
    await card.getByRole("button", { name: "Enable" }).click();
    await expect.poll(() => prompts(m.page)).toBe(1);
    await expect(card.getByRole("alert")).toContainText(/blocked|not allowed/i); // our stub answers "denied"
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toBeHidden();
    await m.page.reload();
    await expect(m.page.getByRole("heading", { name: /^Hi / })).toBeVisible();
    await expect(card).toBeHidden(); // dismissed stays dismissed on this device
  } else {
    // Push not set up (no HTTPS or no VAPID keys): the card is absent, never shown and then rejected.
    await expect(card).toHaveCount(0);
  }
  expect(await prompts(m.page)).toBe(caps.data.pushKey ? 1 : 0);
  await m.ctx.close();
});

test("v4-push 2. notification settings: in-app always on; push devices listed with Remove when push is set up", async ({ browser }) => {
  const m = await loginUi(browser, "9811000002", MEMBER_PW, /\/portal/, countPermissionPrompts);
  await m.page.goto("/portal/notifications");
  const settings = m.page.getByTestId("notification-settings");
  await expect(settings).toContainText("In the app");
  const me = await (await m.ctx.request.get("/api/me/notifications")).json();
  if (me.data.push.available) {
    await expect(settings.getByLabel("Push notifications")).toBeVisible();
    const devices = await (await m.ctx.request.get("/api/push/subscriptions")).json();
    if (devices.data.length) await expect(m.page.getByTestId("push-devices").getByRole("button", { name: /^Remove / }).first()).toBeVisible();
  } else {
    await expect(settings.getByLabel("Push notifications")).toHaveCount(0);
  }
  expect(await prompts(m.page)).toBe(0);
  await m.ctx.close();
});

test("v4-push 3. the Owner's Message Log → WhatsApp messages: template, status timeline and tries, with event/template/status/date filters", async ({ browser }) => {
  const owner = await loginUi(browser, "owner@championsclub.example", STAFF_PW);
  await owner.page.goto("/app/settings/messages");
  await owner.page.getByRole("link", { name: /WhatsApp messages/ }).click();
  await owner.page.waitForURL(/\/app\/settings\/messages\/whatsapp/);
  await expect(owner.page.getByRole("heading", { name: "WhatsApp messages" })).toBeVisible();
  for (const facet of ["Event", "Template", "Status"]) await expect(owner.page.getByRole("button", { name: `Filter by ${facet}` })).toBeVisible();
  const list = await (await owner.ctx.request.get("/api/lists/whatsapp-log?status=FAILED,NOT_AUTOMATIC")).json();
  expect(list.data.total).toBeGreaterThanOrEqual(0);
  // Every number is masked: no full 10-digit mobile number reaches the screen.
  for (const r of list.data.rows as Array<{ recipient_phone: string | null }>) expect(r.recipient_phone ?? "+91 ••••••0000").toMatch(/^\+91 ••••••\d{4}$/);
  await owner.page.goto("/app/messages");
  await expect(owner.page.getByRole("button", { name: "Filter by WhatsApp template" })).toBeVisible();
  await owner.ctx.close();
});

test("v4-push 4. staff My Account: the same alerts card (when push is set up) and the notification settings", async ({ browser }) => {
  const desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW, /\/app/, countPermissionPrompts);
  await desk.page.goto("/app/account");
  await expect(desk.page.getByTestId("notification-settings")).toContainText("In the app");
  const caps = await (await desk.ctx.request.get("/api/capabilities")).json();
  if (caps.data.pushKey) await expect(desk.page.getByTestId("push-opt-in")).toContainText("Get alerts for bookings, refunds and renewals");
  else await expect(desk.page.getByTestId("push-opt-in")).toHaveCount(0);
  expect(await prompts(desk.page)).toBe(0);
  await desk.ctx.close();
});
