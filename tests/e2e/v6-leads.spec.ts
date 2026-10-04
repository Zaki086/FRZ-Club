// v6 §3 (LEADS) e2e — the lead runs Playwright against the seeded sample data (cash only).
//  - LD-1 drag & drop with the mouse: New → Contacted moves at once, the column counts follow (LD-3), the optional
//    quick note is logged on the timeline (LD-4);
//  - the dnd-kit keyboard sensor: focus a card, Space, →, Space;
//  - LD-2 "Move to…": → Lost needs a reason (Cancel snaps back), the desk can't reopen, the Manager reopens with a
//    reason; a refused move shows the server's message; out of Won is not offered;
//  - DESK-1: the front desk's Check-in & Search Members shows every member with the FilterBar.
import { expect, test, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";
const RUN = Date.now().toString(36).slice(-5);
const ALL = "status=NEW%2CCONTACTED%2CQUOTED%2CWON%2CLOST";

async function loginUi(browser: Browser, identifier: string, lands: RegExp): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(STAFF_PW);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(lands);
  return page;
}

/** A fresh walk-in lead (through the API, as the logged-in staff member), shown alone on the board by its name. */
async function newLead(page: Page, name: string): Promise<{ id: string; code: string }> {
  const res = await page.request.post("/api/crm/leads", { data: { name, phone: `98${String(Date.now()).slice(-8)}`, source: "WALK_IN", interest: "Silver membership" } });
  expect(res.status()).toBe(200);
  const lead = ((await res.json()) as { data: { id: string; code: string } }).data;
  await page.goto(`/app/crm?${ALL}&q=${encodeURIComponent(name)}`);
  await expect(page.getByTestId("lead-card").filter({ hasText: name })).toBeVisible();
  return lead;
}

const column = (page: Page, s: string) => page.getByTestId(`lead-column-${s}`);
const cardIn = (page: Page, s: string, name: string) => column(page, s).getByTestId("lead-card").filter({ hasText: name });

async function leadOf(page: Page, id: string) {
  const res = await page.request.get(`/api/crm/leads/${id}`);
  return ((await res.json()) as { data: { status: string; lostReason: string | null; activities: Array<{ type: string; note: string }> } }).data;
}

let desk: Page;
let manager: Page;

test.beforeAll(() => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
});

test("LD-1/LD-3/LD-4: drag a card from New to Contacted with the mouse; counts follow; the quick note lands on the timeline", async ({ browser }) => {
  desk = await loginUi(browser, "desk@championsclub.example", /\/app\/desk/);
  const name = `E2E Drag ${RUN}`;
  const lead = await newLead(desk, name);
  await expect(desk.getByTestId("lead-count-NEW")).toHaveText("1");
  await expect(desk.getByTestId("lead-count-CONTACTED")).toHaveText("0");

  const card = cardIn(desk, "NEW", name);
  const from = (await card.boundingBox())!;
  const to = (await column(desk, "CONTACTED").boundingBox())!;
  await desk.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await desk.mouse.down();
  await desk.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 5, { steps: 4 });
  await desk.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 20 });
  await expect(column(desk, "CONTACTED")).toHaveAttribute("data-over", "true");
  await desk.mouse.up();

  // Moved at once (optimistic), counts updated, then the optional quick note.
  await expect(cardIn(desk, "CONTACTED", name)).toBeVisible();
  await expect(desk.getByTestId("lead-count-NEW")).toHaveText("0");
  await expect(desk.getByTestId("lead-count-CONTACTED")).toHaveText("1");
  const note = desk.getByTestId("lead-move-dialog-note");
  await expect(note).toBeVisible();
  await note.getByLabel("Quick note (optional)").fill("Dragged after the first call");
  await note.getByRole("button", { name: "Save note" }).click();
  await expect(note).toBeHidden();

  const after = await leadOf(desk, lead.id);
  expect(after.status).toBe("CONTACTED");
  expect(after.activities.map((a) => a.note)).toEqual(expect.arrayContaining(["Moved New → Contacted", "Dragged after the first call"]));
  // The card still opens the lead (a drag doesn't, a click does).
  await cardIn(desk, "CONTACTED", name).getByTestId("lead-card-link").click();
  await desk.waitForURL(new RegExp(`/app/crm/${lead.id}$`));
  await expect(desk.getByText("Moved New → Contacted")).toBeVisible();
});

test("LD-1: keyboard move with the dnd-kit keyboard sensor — focus the card, Space, →, Space", async () => {
  const name = `E2E Keys ${RUN}`;
  const lead = await newLead(desk, name);
  const card = cardIn(desk, "NEW", name);
  await card.focus();
  await desk.keyboard.press("Space");
  await expect(card).toHaveAttribute("aria-pressed", "true"); // lifted
  await desk.keyboard.press("ArrowRight");
  await expect(column(desk, "CONTACTED")).toHaveAttribute("data-over", "true");
  await desk.keyboard.press("Space");
  await expect(cardIn(desk, "CONTACTED", name)).toBeVisible();
  await desk.getByTestId("lead-move-dialog-note").getByRole("button", { name: "Skip" }).click();
  expect((await leadOf(desk, lead.id)).status).toBe("CONTACTED");
  // Escape cancels a keyboard drag: nothing moves.
  const card2 = cardIn(desk, "CONTACTED", name);
  await card2.focus();
  await desk.keyboard.press("Space");
  await expect(card2).toHaveAttribute("aria-pressed", "true");
  await desk.keyboard.press("ArrowRight");
  await expect(column(desk, "QUOTED")).toHaveAttribute("data-over", "true");
  await desk.keyboard.press("Escape");
  await expect(cardIn(desk, "CONTACTED", name)).toBeVisible();
  expect((await leadOf(desk, lead.id)).status).toBe("CONTACTED");
});

test("LD-2: Move to… — Lost needs a reason (Cancel snaps back); the desk can't reopen; the Manager reopens with a reason", async ({ browser }) => {
  const name = `E2E Menu ${RUN}`;
  const lead = await newLead(desk, name);
  const menu = () => desk.getByRole("button", { name: `Move ${name} to…` });

  // Backwards isn't offered: from New, "Won" opens Convert to member and "Lost" asks for a reason.
  await menu().click();
  await desk.getByTestId("move-to-LOST").click();
  const reason = desk.getByTestId("lead-move-dialog-lost");
  await expect(reason).toBeVisible();
  await expect(cardIn(desk, "LOST", name)).toBeVisible(); // shown in Lost while the dialog is open
  await reason.getByRole("button", { name: "Cancel" }).click();
  await expect(cardIn(desk, "NEW", name)).toBeVisible(); // snapped back
  expect((await leadOf(desk, lead.id)).status).toBe("NEW");

  await menu().click();
  await desk.getByTestId("move-to-LOST").click();
  await desk.getByTestId("lead-move-dialog-lost").getByLabel("Reason (required)").fill("Joined another club");
  await desk.getByTestId("lead-move-dialog-lost").getByRole("button", { name: "Mark lost" }).click();
  await expect(cardIn(desk, "LOST", name)).toBeVisible();
  await expect.poll(async () => (await leadOf(desk, lead.id)).lostReason).toBe("Joined another club");

  // The desk: reopening is the Manager's/Owner's — the menu says why, and the server refuses it (403).
  await menu().click();
  await expect(desk.getByTestId("move-to-NEW")).toHaveAttribute("data-disabled", "");
  await expect(desk.getByTestId("move-to-NEW")).toContainText("Only a Manager or the Owner can reopen a lost lead.");
  await desk.keyboard.press("Escape");
  const refused = await desk.request.post(`/api/crm/leads/${lead.id}/move`, { data: { to: "NEW", reason: "They called back" } });
  expect(refused.status()).toBe(403);

  // The Manager reopens it with a reason ("Reopened"), on the timeline.
  manager = await loginUi(browser, "manager@championsclub.example", /\/app/);
  await manager.goto(`/app/crm?${ALL}&q=${encodeURIComponent(name)}`);
  await manager.getByRole("button", { name: `Move ${name} to…` }).click();
  await manager.getByTestId("move-to-NEW").click();
  const reopen = manager.getByTestId("lead-move-dialog-reopen");
  await reopen.getByLabel("Reason (required)").fill("They called back");
  await reopen.getByRole("button", { name: "Reopen" }).click();
  await expect(cardIn(manager, "NEW", name)).toBeVisible();
  const after = await leadOf(manager, lead.id);
  expect(after.status).toBe("NEW");
  expect(after.activities.map((a) => a.note)).toContain("Reopened → New: They called back");
});

test("LD-1: → Quoted with no quote opens the quote builder (closing it snaps back); → Won opens Convert to member", async () => {
  const name = `E2E Quote ${RUN}`;
  const lead = await newLead(desk, name);
  await desk.getByRole("button", { name: `Move ${name} to…` }).click();
  await desk.getByTestId("move-to-QUOTED").click();
  const builder = desk.getByTestId("lead-move-dialog-quote-builder");
  await expect(builder).toBeVisible();
  await expect(builder.getByRole("button", { name: "Create & send quote" })).toBeVisible();
  await desk.keyboard.press("Escape");
  await expect(cardIn(desk, "NEW", name)).toBeVisible();
  expect((await leadOf(desk, lead.id)).status).toBe("NEW");

  // A refused move shows the server's message (LD-1): straight to Quoted without a quote.
  const r = await desk.request.post(`/api/crm/leads/${lead.id}/move`, { data: { to: "QUOTED" } });
  expect(r.status()).toBe(409);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("LEAD_MOVE_NOT_ALLOWED");

  await desk.getByRole("button", { name: `Move ${name} to…` }).click();
  await desk.getByTestId("move-to-WON").click();
  const convert = desk.getByTestId("lead-move-dialog-convert");
  await expect(convert).toBeVisible();
  await expect(cardIn(desk, "NEW", name)).toBeVisible(); // stays put until the membership is paid
  await convert.getByTestId("convert-lead").click();
  await desk.waitForURL(/\/app\/members\/new\?leadId=/);
});

test("LD-1: out of Won is not allowed — a won card says why and offers no column", async () => {
  await desk.goto("/app/crm?status=WON");
  const won = desk.locator('[data-testid="lead-card"][data-status="WON"]').first();
  if ((await won.count()) === 0) {
    test.info().annotations.push({ type: "note", description: "no won lead in the sample data — covered by the integration rule tests" });
    return;
  }
  await expect(won).toHaveAttribute("title", "Won is final — a won lead can't be moved to another column.");
  await won.getByTestId("lead-move-menu").click();
  for (const s of ["NEW", "CONTACTED", "QUOTED", "LOST"]) await expect(desk.getByTestId(`move-to-${s}`)).toHaveAttribute("data-disabled", "");
  await desk.keyboard.press("Escape");
});

test("DESK-1: the front desk's Check-in & Search Members shows every member with the FilterBar; Members stays closed", async () => {
  await desk.goto("/app/desk");
  await expect(desk.getByTestId("desk-today")).toBeVisible();
  await expect(desk.getByTestId("desk-search")).toBeVisible();
  const list = desk.getByTestId("desk-members");
  await expect(list.getByTestId("summary-strip")).toBeVisible();
  await expect(list.getByTestId("filter-bar")).toBeVisible();
  await expect(list.getByTestId("result-count")).toBeVisible();
  await list.getByTestId("summary-strip").getByRole("button", { name: /With dues/ }).click();
  await desk.waitForURL(/\/app\/desk\?.*dues=yes/);
  await expect(list.getByRole("button", { name: /Remove filter Dues: Has dues/ })).toBeVisible();
  await list.getByRole("button", { name: "Clear all" }).click();
  await expect(desk).not.toHaveURL(/dues=yes/);
  // A row opens the member.
  await list.getByRole("row").nth(1).click();
  await desk.waitForURL(/\/app\/members\/[a-z0-9]+$/);
  // The sidebar is unchanged (no "Members" entry) and /app/members is still 403 for the desk.
  await expect(desk.getByRole("navigation").getByRole("link", { name: "Members", exact: true })).toHaveCount(0);
  const res = await desk.goto("/app/members");
  expect(res?.status()).toBe(403);
});
