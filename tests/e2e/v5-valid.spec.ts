// v5 §2.3 (VALID) e2e — the lead runs Playwright against the seeded sample data. The shared phone / email inputs
// (src/components/contact-inputs.tsx) on the desk's new-member form and the public trial form:
//  - no error while a field is typed for the first time; the exact message appears on blur and clears once fixed;
//  - phones are type="tel", inputmode="numeric", autocomplete="tel" with a visible +91; emails are type="email";
//  - submitting with an invalid number is stopped in the browser (inline message), and the server answers 422 naming
//    the field when the browser is bypassed.
import { expect, test, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const MOBILE = "Enter a valid 10-digit Indian mobile number.";
const EMAIL = "Enter a valid email address.";

async function loginUi(browser: Browser, identifier: string, lands: RegExp): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(STAFF_PW);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands);
  return page;
}

test.beforeAll(() => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
});

test("CV-8: desk new-member form — inline errors appear on blur and clear when fixed", async ({ browser }) => {
  const page = await loginUi(browser, "desk@championsclub.example", /\/app\/desk/);
  await page.goto("/app/members/new");
  const phone = page.locator('input[name="phone"]');
  const email = page.locator('input[name="email"]');

  // Wiring: the shared inputs, with the +91 prefix on the mobile.
  await expect(phone).toHaveAttribute("type", "tel");
  await expect(phone).toHaveAttribute("inputmode", "numeric");
  await expect(phone).toHaveAttribute("autocomplete", "tel");
  await expect(phone).toHaveAttribute("data-validate", "phone");
  await expect(page.locator('[data-prefix="+91"]').first()).toBeVisible();
  await expect(email).toHaveAttribute("type", "email");
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(email).toHaveAttribute("data-validate", "email");

  // Typing the first time: no error yet.
  await phone.pressSequentially("98765");
  await expect(page.getByText(MOBILE)).toHaveCount(0);
  // Leaving the field shows the message under it.
  await phone.blur();
  await expect(page.getByText(MOBILE)).toBeVisible();
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  // Fixing it clears the message as soon as the number is valid.
  await phone.fill("+91 98765 12399");
  await expect(page.getByText(MOBILE)).toHaveCount(0);
  await expect(phone).not.toHaveAttribute("aria-invalid", "true");

  await email.fill("new.member@mail");
  await expect(page.getByText(EMAIL)).toHaveCount(0);
  await email.blur();
  await expect(page.getByText(EMAIL)).toBeVisible();
  await email.fill("new.member@mail.com");
  await expect(page.getByText(EMAIL)).toHaveCount(0);

  // Submitting with an invalid number is stopped in the browser with the inline message (no sign-up request).
  await phone.fill("12345");
  await page.locator('input[name="name"]').fill("E2E Invalid Phone");
  await page.locator('input[name="dob"]').fill("1990-01-01");
  let posted = false;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/members")) posted = true;
  });
  await page.getByTestId("signup-submit").click();
  await expect(page.getByText(MOBILE)).toBeVisible();
  expect(posted).toBe(false);
  await expect(page).toHaveURL(/\/app\/members\/new/);

  // The server is authoritative: the same input sent straight to the API is 422 naming the field.
  const res = await page.request.post("/api/members", { data: { name: "E2E Invalid Phone", phone: "12345", dob: "1990-01-01" } });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe("VALIDATION_FAILED");
  expect(body.error.message).toContain(`phone: ${MOBILE}`);
  await page.context().close();
});

test("CV-8: public trial form — inline errors appear on blur and clear when fixed", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto("/trial");
  const phone = page.locator('input[name="phone"]');
  const email = page.locator('input[name="email"]');
  await expect(phone).toBeVisible();
  await expect(phone).toHaveAttribute("type", "tel");
  await expect(phone).toHaveAttribute("data-validate", "phone");
  await expect(page.locator('[data-prefix="+91"]').first()).toBeVisible();

  await phone.pressSequentially("99999 99999");
  await expect(page.getByText(MOBILE)).toHaveCount(0);
  await phone.blur();
  await expect(page.getByText(MOBILE)).toBeVisible();
  await phone.fill("98765 12398");
  await expect(page.getByText(MOBILE)).toHaveCount(0);

  await email.pressSequentially("visitor@@mail.com");
  await expect(page.getByText(EMAIL)).toHaveCount(0);
  await email.blur();
  await expect(page.getByText(EMAIL)).toBeVisible();
  await email.fill("visitor@mail.com");
  await expect(page.getByText(EMAIL)).toHaveCount(0);

  // The public API refuses an invalid number with the field name (422).
  const res = await page.request.post("/api/trial", { data: { consent: true, name: "E2E Trial", phone: "12345", courtId: "x", date: "2026-01-01", startTime: "10:00" } });
  expect(res.status()).toBe(422);
  expect((await res.json()).error.message).toContain(`phone: ${MOBILE}`);
  await ctx.close();
});
