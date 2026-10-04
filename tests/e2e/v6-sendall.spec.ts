// v6 §2.3 (SENDALL) e2e steps, in the style of v4-*/v5-*.spec.ts, against the seeded test club (no WhatsApp Cloud API
// there, so the email & push path). The lead runs Playwright. Setup that is not a screen (one fresh manual WhatsApp
// task from a template) goes through the API; everything the step is about is done on screen.
//  1. Front desk: Messages to Send → "Send all by email & push" → the preflight dialog (computed on the server: counts
//     per channel, skipped, can't send) explains that WhatsApp needs the API and says "Ask the owner to finish WhatsApp
//     setup"; the ⓘ explains the official-API-only rule → confirm → live progress → summary.
//  2. Owner: the same preflight links to Settings → WhatsApp, which opens on the WhatsApp tab.
//  3. A second confirm while a job runs returns the same job (SA-8) — checked through the API.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const QUEUE = "/app/messages?channel=WHATSAPP_MANUAL&status=QUEUED%2CLINK_OPENED";

type Session = { ctx: BrowserContext; page: Page };
let desk: Session;
let whatsappApi = false;

async function loginUi(browser: Browser, identifier: string, password: string, lands?: RegExp): Promise<Session> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands ?? /\/(app|portal)/);
  await ctx.route(/^https:\/\/(api\.)?wa\.me\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>WhatsApp</title>" }));
  return { ctx, page };
}

/** One fresh manual WhatsApp task: a transactional template sent "by hand" to a member with a mobile number. */
async function queueOneTask(s: Session) {
  const members = await s.ctx.request.get("/api/lists/renewals?size=25");
  expect(members.ok(), await members.text()).toBe(true);
  const rows = ((await members.json()).data.rows ?? []) as Array<{ id: string; phone: string | null }>;
  for (const m of rows.filter((r) => r.phone)) {
    const t = await s.ctx.request.get(`/api/messages/templates?context=MEMBER&recordId=${m.id}`);
    if (!t.ok()) continue;
    const list = (await t.json()).data.templates as Array<{ id: string; key: string | null; availableChannels: string[] }>;
    const tpl = list.find((x) => x.key === "membership_expiring" && x.availableChannels.includes("WHATSAPP"))
      ?? list.find((x) => x.key === "membership_expired" && x.availableChannels.includes("WHATSAPP"));
    if (!tpl) continue;
    const r = await s.ctx.request.post("/api/messages/send", { data: { templateId: tpl.id, context: "MEMBER", recordId: m.id, channels: ["WHATSAPP"], confirmDuplicate: true } });
    if (r.ok()) return;
  }
  throw new Error("No member in Renewal & Dues could get a WhatsApp message");
}

test.beforeAll(async ({ browser }) => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
  desk = await loginUi(browser, "desk@championsclub.example", STAFF_PW, /\/app\/desk/);
  const caps = await desk.ctx.request.get("/api/capabilities");
  whatsappApi = !!(await caps.json()).data.whatsappApi;
  await queueOneTask(desk);
});

test.afterAll(async () => {
  await desk?.ctx.close();
});

test("SA-5/SA-6/SA-9: front desk — Send all by email & push: the preflight explains WhatsApp needs the API; confirm → progress → summary", async () => {
  test.skip(whatsappApi, "the test club has the WhatsApp API on — this step covers the email & push path");
  const { page } = desk;
  await page.goto(QUEUE);
  const button = page.getByTestId("send-all");
  await expect(button).toHaveText(/Send all by email & push/);
  await button.click();
  const dialog = page.getByTestId("send-all-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("send-all-preflight")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("send-all-no-api")).toContainText("the WhatsApp API isn't set up");
  await expect(page.getByTestId("send-all-ask-owner")).toHaveText("Ask the owner to finish WhatsApp setup.");
  await expect(page.getByTestId("send-all-setup-link")).toHaveCount(0);
  // Server-computed counts: nothing goes by WhatsApp; every queued task is counted somewhere.
  await expect(page.getByTestId("send-all-count-whatsapp")).toHaveText("0");
  const total = Number((await page.getByTestId("send-all-total").innerText()).match(/\d+/)![0]);
  expect(total).toBeGreaterThan(0);
  const num = async (id: string) => Number(await page.getByTestId(id).innerText());
  const counted = (await num("send-all-count-email")) + (await num("send-all-count-push")) + (await num("send-all-count-not-relevant"))
    + (await num("send-all-count-duplicate")) + (await num("send-all-count-expired")) + (await num("send-all-count-cannot"));
  expect(counted).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("send-all-cannot-reasons")).toContainText("WhatsApp API not set up");
  // ⓘ: the official-API-only rule.
  await page.getByRole("button", { name: "About sending all" }).click();
  await expect(page.getByText(/only through the official WhatsApp Cloud API/)).toBeVisible();
  await page.keyboard.press("Escape");
  // "Use other channels" off: nothing can go automatically without the API.
  await page.getByTestId("send-all-use-other").uncheck();
  await expect(page.getByTestId("send-all-count-email")).toHaveText("0");
  await page.getByTestId("send-all-use-other").check();
  const confirm = page.getByTestId("send-all-confirm");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const progress = page.getByTestId("send-all-progress");
  await expect(progress).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Send all progress" })).toBeVisible();
  await expect(progress).toHaveAttribute("data-status", "DONE", { timeout: 120_000 });
  await expect(page.getByTestId("send-all-summary")).toContainText(/Done: \d+ sent, \d+ failed/);
});

test("SA-8: a second confirm while a job runs returns the same job", async () => {
  const filter = "type=TEMPLATE_MESSAGE";
  const one = await desk.ctx.request.post("/api/messages/send-all", { data: { filter } });
  const two = await desk.ctx.request.post("/api/messages/send-all", { data: { filter } });
  expect(one.ok(), await one.text()).toBe(true);
  const a = (await one.json()).data;
  const b = (await two.json()).data;
  if (a.job.status !== "DONE") expect(b).toMatchObject({ created: false, job: { id: a.job.id } });
  const job = await desk.ctx.request.get(`/api/messages/send-all/${a.job.id}`);
  expect((await job.json()).data).toMatchObject({ id: a.job.id, total: expect.any(Number), remaining: expect.any(Number) });
});

test("SA-9: owner — the preflight links to Settings → WhatsApp", async ({ browser }) => {
  test.skip(whatsappApi, "the test club has the WhatsApp API on");
  const owner = await loginUi(browser, "owner@championsclub.example", STAFF_PW);
  await queueOneTask(owner);
  await owner.page.goto(QUEUE);
  await owner.page.getByTestId("send-all").click();
  const link = owner.page.getByTestId("send-all-setup-link");
  await expect(link).toHaveText("Settings → WhatsApp", { timeout: 30_000 });
  await link.click();
  await owner.page.waitForURL(/\/app\/settings\?tab=whatsapp/);
  await expect(owner.page.getByRole("tab", { name: "WhatsApp" })).toHaveAttribute("aria-selected", "true");
  await owner.ctx.close();
});
