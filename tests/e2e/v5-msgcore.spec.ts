// v5 §3.1–3.2 (MSGCORE) e2e steps, in the style of ui-flows.spec.ts / v4-*.spec.ts, against the seeded sample data.
// The lead runs Playwright. The composer and bulk screens are MSGUI's (tests/e2e/v5-msgui.spec.ts).
//  1. Owner: Settings → Message templates lists the 18 ready-made templates; the editor shows the context's variables,
//     previews the text with a real member (MT-2) and saves an edit as a new version (MT-3); an unknown variable is
//     refused with UNKNOWN_TEMPLATE_VARIABLE (MT-1).
//  2. /unsubscribe/<token>: a forged link is refused; the real one stops announcement emails in one click and
//     "Subscribe again" undoes it (MT-10).
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signUnsubscribeToken } from "../../src/server/services/messages/unsubscribe";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MEMBER = { phone: "9811000002", name: "Neha Kapoor" }; // sample persona (Silver)
const READY_MADE = [
  "membership_expiring", "membership_expired", "dues_reminder", "welcome_portal", "booking_reminder", "booking_cancelled", "session_cancelled_by_club",
  "reschedule_confirmed", "refund_ready", "refund_collected", "order_ready", "restring_ready", "settle_tab", "trial_follow_up", "quote_follow_up",
  "invoice_due", "friday_social", "club_notice",
];
const db = new PrismaClient();

type Session = { ctx: BrowserContext; page: Page };

async function loginUi(browser: Browser, identifier: string, password: string, lands?: RegExp): Promise<Session> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands ?? /\/(app|portal)/);
  return { ctx, page };
}

test.beforeAll(() => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
});
test.afterAll(async () => {
  await db.$disconnect();
});

test("v5-msgcore 1. Settings → Message templates: the 18 ready-made templates, variables, live preview, versions, MT-1", async ({ browser }) => {
  const owner = await loginUi(browser, "owner@championsclub.example", STAFF_PW);
  const page = owner.page;
  await page.goto("/app/settings");
  await page.getByRole("tab", { name: "Message templates" }).click();
  const list = page.getByTestId("message-templates");
  for (const key of READY_MADE) await expect(list.getByTestId(`mt-row-${key}`)).toBeVisible();
  await expect(list.getByTestId("mt-row-friday_social")).toContainText("Announcement");

  // Open "Dues reminder": its variables, then a preview with a real member.
  const before = await db.messageTemplate.findUniqueOrThrow({ where: { key: "dues_reminder" } });
  await list.getByRole("button", { name: "Edit Dues reminder" }).click();
  const editor = page.getByTestId("mt-editor");
  await expect(editor.getByTestId("mt-variables")).toContainText("{{dues.amount}}");
  await expect(editor.getByTestId("mt-variables")).not.toContainText("{{booking.code}}");
  const preview = editor.getByTestId("mt-preview");
  await preview.getByLabel("Find a record to preview with").fill("Neha");
  await expect(preview.getByLabel("Record to preview with", { exact: true }).locator("option", { hasText: MEMBER.name })).toHaveCount(1);
  await preview.getByLabel("Record to preview with", { exact: true }).selectOption({ label: (await preview.getByLabel("Record to preview with", { exact: true }).locator("option", { hasText: MEMBER.name }).textContent())! });
  await expect(preview.getByText(/^Hi Neha, a friendly reminder from /)).toBeVisible();
  await expect(preview.locator('iframe[title="Email preview"]')).toBeVisible();

  // MT-1: an unknown variable is refused on save.
  const wa = editor.getByLabel(/^WhatsApp text/);
  const original = await wa.inputValue();
  await wa.fill(`${original}\nYour booking {{booking.code}}`);
  await editor.getByTestId("mt-save").click();
  await expect(editor.getByRole("alert")).toContainText("UNKNOWN_TEMPLATE_VARIABLE");
  await expect(editor.getByRole("alert")).toContainText("{{booking.code}}");

  // MT-3: a valid edit is saved as the next version; then the original text again (one more version).
  await wa.fill(`${original}\nSee you at the club!`);
  await editor.getByTestId("mt-save").click();
  await expect(editor.getByRole("status")).toHaveText(`Saved — version ${before.version + 1}.`);
  await expect(editor.getByText(`Versions (${before.version + 1})`)).toBeVisible();
  await wa.fill(original);
  await editor.getByTestId("mt-save").click();
  await expect(editor.getByRole("status")).toHaveText(`Saved — version ${before.version + 2}.`);
  const after = await db.messageTemplate.findUniqueOrThrow({ where: { key: "dues_reminder" } });
  expect(after.whatsappText).toBe(original);
  expect(await db.messageTemplateVersion.count({ where: { templateId: after.id } })).toBe(before.version + 2);
  await owner.ctx.close();
});

test("v5-msgcore 2. the announcement unsubscribe link: forged → refused; real → one click unsubscribes; Subscribe again undoes it", async ({ browser }) => {
  const member = await db.member.findUniqueOrThrow({ where: { phone: MEMBER.phone } });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/unsubscribe/UN1.m.${member.id}.forgedforgedforgedforgedforged12`);
  await expect(page.getByTestId("unsubscribe-error")).toContainText("not valid");

  await page.goto(`/unsubscribe/${signUnsubscribeToken("m", member.id)}`);
  await expect(page.getByTestId("unsubscribe-page")).toContainText("You won't get announcement emails");
  expect((await db.member.findUniqueOrThrow({ where: { id: member.id } })).emailAnnouncementsOptOut).toBe(true);
  await page.getByTestId("resubscribe").click();
  await expect(page.getByTestId("resubscribed")).toBeVisible();
  expect((await db.member.findUniqueOrThrow({ where: { id: member.id } })).emailAnnouncementsOptOut).toBe(false);
  await ctx.close();
});
