// v4 §1 e2e (the lead runs Playwright): step 4 "Sidebars per role match §1.1 exactly", plus the access rule (RN-1/RN-2)
// and the new screens (Check-in Risk, Employees, the dashboards' approvals panel). Run against the seeded sample data.
import { expect, test, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const STAFF_PW = process.env.SEED_STAFF_PASSWORD ?? "";

async function loginUi(browser: Browser, identifier: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Phone or email").fill(identifier);
  await page.getByLabel("Password").fill(STAFF_PW);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(/\/app/);
  return page;
}

/** v4 §1.1, word for word (Owner, Manager, Front desk); the other roles' menus are unchanged from v3. */
const MENUS: Array<{ who: string; login: string; items: string[] }> = [
  {
    who: "owner", login: "owner@championsclub.example",
    items: ["Dashboard", "Employees", "Command Centre", "Invoices", "Business Clients", "Expenses", "Payroll", "GST Reports", "Ledgers", "Cash Reconciliation", "Cash Drawers", "My Account", "Staff Directory", "Attendance", "Price Book", "Reports & Sharing", "Settings", "Audit Log", "Message Log", "Notification Log", "Backups", "Data Requests"],
  },
  {
    who: "manager", login: "manager@championsclub.example",
    items: ["Dashboard", "Members", "Command Centre", "Bookings", "Social Play", "Social Players", "Purchase Orders", "Stock & Receipts", "Counter Sales", "Bar Day & Close", "Leads Board", "Invoices", "Business Clients", "Expenses", "Cash Reconciliation", "My Account", "Staff Directory", "Attendance", "Rosters", "Leave Approvals", "Staff Activity"],
  },
  {
    who: "front desk", login: "desk@championsclub.example",
    items: ["Dashboard", "My Cash Drawer", "Refunds", "Check-in & Search Members", "New Members", "Renewal & Dues", "Messages to Send", "Check-in Risk", "Command Centre", "Bookings", "Social Play", "Social Players", "Leads Board", "My Shifts & Leave", "My Account", "Notifications"],
  },
  {
    who: "shop", login: "shop@championsclub.example",
    items: ["Counter POS", "Online orders", "Restring queue", "Counter sales", "Products & pricing", "Stock & receipts", "Stock movements", "Purchase orders", "Stock take", "Refunds", "My cash drawer", "My shifts & leave", "My account"],
  },
  { who: "bar", login: "bar@championsclub.example", items: ["Tables & tabs", "Ready to serve", "Kitchen display", "All bar tabs", "Bar day & close", "Refunds", "My cash drawer", "My shifts & leave", "My account"] },
  { who: "kitchen", login: "kitchen@championsclub.example", items: ["Kitchen display", "My shifts & leave", "My account"] },
  {
    who: "accountant", login: "accounts@championsclub.example",
    items: ["Cash reconciliation", "All cash drawers", "Invoices", "Business clients", "Expenses", "Payroll", "GST report", "Ledger", "Refunds", "My cash drawer", "Dashboard", "Reports & sharing", "Attendance", "Staff directory", "My shifts & leave", "My account"],
  },
];

test.beforeAll(() => {
  expect(STAFF_PW.length, "set SEED_STAFF_PASSWORD").toBeGreaterThanOrEqual(8);
});

test("4. Sidebars per role match §1.1 exactly (labels and order); shop, bar, kitchen and accountant are unchanged", async ({ browser }) => {
  for (const m of MENUS) {
    const page = await loginUi(browser, m.login);
    const items = (await page.locator("aside nav a").allInnerTexts()).map((t) => t.trim());
    expect(items, m.who).toEqual(m.items);
    await page.context().close();
  }
});

test("RN-1: the Manager and the Front desk get 403 off their menu; listed and detail pages open", async ({ browser }) => {
  const mgr = await loginUi(browser, "manager@championsclub.example");
  for (const p of ["/app/pricing", "/app/desk", "/app/messages", "/app/shop", "/app/reports", "/app/settings"]) {
    expect((await mgr.goto(p))?.status(), `manager ${p}`).toBe(403);
  }
  for (const p of ["/app", "/app/members", "/app/courts", "/app/shop/stock", "/app/bar/day", "/app/staff/leave", "/app/account", "/app/notifications"]) {
    expect((await mgr.goto(p))?.status(), `manager ${p}`).toBe(200);
  }
  // A detail page reached from a listed one (Staff Directory → an employee).
  await mgr.goto("/app/staff/employees");
  await mgr.locator("tbody tr a[href^='/app/staff/employees/']").first().click();
  await expect(mgr.getByTestId("employee-summary")).toBeVisible();
  await mgr.context().close();

  const desk = await loginUi(browser, "desk@championsclub.example");
  for (const p of ["/app/members", "/app/shop", "/app/staff/employees", "/app/finance/invoices", "/app/pricing", "/app/employees"]) {
    expect((await desk.goto(p))?.status(), `desk ${p}`).toBe(403);
  }
  for (const p of ["/app", "/app/drawer", "/app/refunds", "/app/desk", "/app/members/new", "/app/desk/expiring", "/app/desk/risk", "/app/courts/social/players", "/app/crm", "/app/staff/me", "/app/notifications"]) {
    expect((await desk.goto(p))?.status(), `desk ${p}`).toBe(200);
  }
  await desk.context().close();
});

test("RN-2: the Owner opens any page by direct link", async ({ browser }) => {
  const owner = await loginUi(browser, "owner@championsclub.example");
  for (const p of ["/app/desk", "/app/members", "/app/shop", "/app/bar", "/app/staff/roster", "/app/staff/leave", "/app/desk/risk"]) {
    expect((await owner.goto(p))?.status(), `owner ${p}`).toBe(200);
  }
  await owner.context().close();
});

test("RN-4 / RN-5: the Owner and Manager dashboards lead with Needs your approval; the desk's dashboard shows its day", async ({ browser }) => {
  const owner = await loginUi(browser, "owner@championsclub.example");
  await owner.goto("/app");
  await expect(owner.getByTestId("approvals-panel")).toBeVisible();
  await expect(owner.getByTestId("owner-cash")).toContainText("Cash in drawers now");
  await owner.goto("/app/employees");
  await expect(owner.getByTestId("employees-admin")).toBeVisible();
  await owner.context().close();

  const mgr = await loginUi(browser, "manager@championsclub.example");
  await mgr.goto("/app");
  await expect(mgr.getByTestId("approvals-panel")).toBeVisible();
  await expect(mgr.getByTestId("manager-today")).toContainText("Court utilization");
  await mgr.context().close();

  const desk = await loginUi(browser, "desk@championsclub.example");
  await desk.goto("/app");
  const d = desk.getByTestId("front-desk-dashboard");
  await expect(d).toBeVisible();
  for (const id of ["fd-drawer", "fd-arrivals", "fd-risks", "fd-refunds", "fd-renewals", "fd-messages", "fd-leads"]) await expect(d.getByTestId(id)).toBeVisible();
  await d.getByTestId("fd-risks").click();
  await desk.waitForURL(/\/app\/desk\/risk/);
  await expect(desk.getByTestId("checkin-risk")).toBeVisible();
  await desk.context().close();
});
