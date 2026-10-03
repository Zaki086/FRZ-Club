// v3 §3.2: staff user accounts (Settings → Users & roles, Owner). Never exposes password hashes or lockout internals
// beyond "locked now".
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

const YES_NO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

export const usersList: ListDef = {
  name: "users",
  title: "Staff users",
  view: ["settings"],
  exportCaps: ["settings"],
  base: () => Prisma.sql`
    SELECT u.id, u.name, u.phone, u.email, u.role::text AS role, u.active, u.last_login_at, u.created_at,
      (u.locked_until IS NOT NULL AND u.locked_until > app_now()) AS locked,
      e.monthly_salary, to_char(e.join_date, 'YYYY-MM-DD') AS join_day
    FROM users u
    LEFT JOIN employees e ON e.user_id = u.id
    WHERE u.role <> 'MEMBER'`,
  search: ["b.name", "b.phone", "b.email"],
  facets: [
    { key: "role", label: "Role", expr: "b.role", options: [
      { value: "OWNER", label: "Owner" }, { value: "MANAGER", label: "Manager" }, { value: "FRONT_DESK", label: "Front desk" }, { value: "SHOP_STAFF", label: "Shop" },
      { value: "BAR_STAFF", label: "Bar" }, { value: "KITCHEN", label: "Kitchen" }, { value: "ACCOUNTANT", label: "Accountant" },
    ] },
    { key: "active", label: "Active", expr: "CASE WHEN b.active THEN 'yes' ELSE 'no' END", options: YES_NO },
    { key: "login", label: "Has logged in", expr: "CASE WHEN b.last_login_at IS NOT NULL THEN 'yes' ELSE 'no' END", options: YES_NO },
    { key: "locked", label: "Locked", expr: "CASE WHEN b.locked THEN 'yes' ELSE 'no' END", options: YES_NO },
  ],
  sorts: {
    role: { label: "Role", sql: "array_position(ARRAY['OWNER', 'MANAGER', 'FRONT_DESK', 'SHOP_STAFF', 'BAR_STAFF', 'ACCOUNTANT', 'KITCHEN'], b.role), b.name ASC" },
    name: { label: "Name", sql: "b.name ASC" },
    login: { label: "Last login", sql: "b.last_login_at DESC NULLS LAST, b.name" },
  },
  defaultSort: "role",
  summary: [
    { key: "active", label: "Active", sql: "count(*) FILTER (WHERE b.active)", format: "count", apply: { active: "yes" } },
    { key: "never", label: "Never logged in", sql: "count(*) FILTER (WHERE b.active AND b.last_login_at IS NULL)", format: "count", apply: { active: "yes", login: "no" } },
    { key: "locked", label: "Locked now", sql: "count(*) FILTER (WHERE b.locked)", format: "count", apply: { locked: "yes" } },
    { key: "inactive", label: "Inactive", sql: "count(*) FILTER (WHERE NOT b.active)", format: "count", apply: { active: "no" } },
  ],
  csv: [
    { key: "name", label: "Name" }, { key: "role", label: "Role" }, { key: "phone", label: "Phone" }, { key: "email", label: "Email" },
    { key: "active", label: "Active" }, { key: "locked", label: "Locked" }, { key: "last_login_at", label: "Last login", format: "datetime" },
    { key: "monthly_salary", label: "Monthly salary (₹)", format: "money" }, { key: "join_day", label: "Joined" },
  ],
};
