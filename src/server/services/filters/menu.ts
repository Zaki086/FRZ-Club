// v5 §1.1: the Menu screen's item list on the standard FilterBar — category, status, food type, alcoholic,
// available, has photo; search by name, description or category. Prices are the items' current base prices.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const menuItemsList: ListDef = {
  name: "menu",
  title: "Menu items",
  view: ["menu.manage"],
  exportCaps: ["menu.manage"],
  base: () => Prisma.sql`
    SELECT i.id, i.name, i.description, i.price, i.is_alcoholic, i.available, i.status::text AS status,
      i.food_type::text AS food_type, CASE WHEN i.food_type IS NOT NULL OR i.category = 'FOOD' THEN 'FOOD' ELSE 'DRINK' END AS kind,
      i.allergens::text[] AS allergens, i.prep_minutes, i.photo_url, i.thumb_url, i.tax_category, i.sort_order, i.created_at, i.updated_at,
      c.id AS category_id, c.name AS category_name, c.icon AS category_icon, c.sort_order AS category_sort, c.active AS category_active
    FROM menu_items i JOIN menu_categories c ON c.id = i.category_id`,
  search: ["b.name", "b.description", "b.category_name"],
  facets: [
    { key: "category", label: "Category", expr: "b.category_id", labelsSql: "SELECT id AS value, name AS label FROM menu_categories" },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "ACTIVE", label: "Active" }, { value: "DRAFT", label: "Draft" }, { value: "ARCHIVED", label: "Archived" }] },
    {
      key: "food", label: "Food type",
      expr: "CASE WHEN b.kind = 'DRINK' THEN 'DRINK' ELSE COALESCE(b.food_type, 'NOT_SET') END",
      options: [{ value: "VEG", label: "Veg" }, { value: "NON_VEG", label: "Non-veg" }, { value: "EGG", label: "Egg" }, { value: "NOT_SET", label: "Food type not set" }, { value: "DRINK", label: "Drink (n/a)" }],
    },
    { key: "alcoholic", label: "Alcoholic", expr: "CASE WHEN b.is_alcoholic THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Alcoholic" }, { value: "no", label: "Non-alcoholic" }] },
    { key: "available", label: "Available", expr: "CASE WHEN b.available THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Available now" }, { value: "no", label: "Sold out" }] },
    { key: "photo", label: "Photo", expr: "CASE WHEN b.photo_url IS NOT NULL THEN 'yes' ELSE 'no' END", options: [{ value: "yes", label: "Has a photo" }, { value: "no", label: "No photo" }] },
  ],
  sorts: {
    menu: { label: "Menu order", sql: "b.category_sort, b.category_name, b.sort_order, b.name" },
    name: { label: "Name", sql: "b.name, b.category_sort" },
    price: { label: "Price", sql: "b.price, b.name" },
    newest: { label: "Newest first", sql: "b.created_at DESC" },
  },
  defaultSort: "menu",
  summary: [
    { key: "active", label: "On the menu", sql: "count(*) FILTER (WHERE b.status = 'ACTIVE' AND b.available AND b.category_active)", format: "count", apply: { status: "ACTIVE", available: "yes" } },
    { key: "soldout", label: "Sold out", sql: "count(*) FILTER (WHERE b.status = 'ACTIVE' AND NOT b.available)", format: "count", apply: { status: "ACTIVE", available: "no" } },
    { key: "draft", label: "Drafts", sql: "count(*) FILTER (WHERE b.status = 'DRAFT')", format: "count", apply: { status: "DRAFT" } },
    { key: "nofood", label: "Food type not set", sql: "count(*) FILTER (WHERE b.kind = 'FOOD' AND b.food_type IS NULL AND b.status <> 'ARCHIVED')", format: "count", apply: { food: "NOT_SET", status: "ACTIVE,DRAFT" } },
    { key: "archived", label: "Archived", sql: "count(*) FILTER (WHERE b.status = 'ARCHIVED')", format: "count", apply: { status: "ARCHIVED" } },
  ],
  csv: [
    { key: "name", label: "Item" }, { key: "category_name", label: "Category" }, { key: "status", label: "Status" }, { key: "kind", label: "Food/drink" },
    { key: "food_type", label: "Food type" }, { key: "is_alcoholic", label: "Alcoholic" }, { key: "price", label: "Price (₹)", format: "money" },
    { key: "available", label: "Available" }, { key: "prep_minutes", label: "Prep (min)" }, { key: "description", label: "Description" },
  ],
  defaults: () => ({ status: "ACTIVE,DRAFT" }),
};
