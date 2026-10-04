-- v5 §1.1 (MENU, additive only): menu categories built by bar staff, and the menu item's member-facing details
-- (description, photo, food type, allergens, prep time, DRAFT/ACTIVE/ARCHIVED status). Existing items become ACTIVE
-- (archived ones ARCHIVED), keep their availability and price, and join a category made from their current
-- category value (Food / Drinks / Alcoholic drinks). Their food type stays empty: the Menu screen asks for it.

CREATE TYPE "MenuItemStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "FoodType" AS ENUM ('VEG', 'NON_VEG', 'EGG');
CREATE TYPE "MenuAllergen" AS ENUM ('GLUTEN', 'DAIRY', 'NUTS', 'EGG', 'SOY', 'SHELLFISH');

CREATE TABLE "menu_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT NOT NULL DEFAULT 'UtensilsCrossed',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT menu_categories_name_len CHECK (char_length(btrim(name)) BETWEEN 2 AND 40),
    CONSTRAINT menu_categories_description_len CHECK (description IS NULL OR char_length(description) <= 300)
);
-- Category names are unique, ignoring case (the table is new, so nothing can collide yet).
CREATE UNIQUE INDEX "menu_categories_name_key" ON "menu_categories" (lower(btrim(name)));
CREATE TRIGGER menu_categories_no_delete BEFORE DELETE ON menu_categories FOR EACH ROW EXECUTE FUNCTION forbid_delete();

ALTER TABLE "menu_items"
    ADD COLUMN "category_id" TEXT,
    ADD COLUMN "description" TEXT,
    ADD COLUMN "photo_url" TEXT,
    ADD COLUMN "thumb_url" TEXT,
    ADD COLUMN "food_type" "FoodType",
    ADD COLUMN "allergens" "MenuAllergen"[] NOT NULL DEFAULT '{}',
    ADD COLUMN "prep_minutes" INTEGER,
    ADD COLUMN "status" "MenuItemStatus" NOT NULL DEFAULT 'ACTIVE';

UPDATE menu_items SET status = 'ARCHIVED' WHERE archived_at IS NOT NULL;

-- Alcoholic → OUTSIDE_GST, otherwise the restaurant rate (already true for every item made through the app).
UPDATE menu_items SET tax_category = CASE WHEN is_alcoholic THEN 'OUTSIDE_GST' ELSE 'RESTAURANT' END
 WHERE tax_category <> CASE WHEN is_alcoholic THEN 'OUTSIDE_GST' ELSE 'RESTAURANT' END;

-- One category per current category value that has items.
INSERT INTO menu_categories (id, name, icon, sort_order, updated_at)
SELECT 'mc_' || lower(d.c::text),
       CASE d.c WHEN 'FOOD' THEN 'Food' WHEN 'BEVERAGE' THEN 'Drinks' ELSE 'Alcoholic drinks' END,
       CASE d.c WHEN 'FOOD' THEN 'UtensilsCrossed' WHEN 'BEVERAGE' THEN 'CupSoda' ELSE 'Wine' END,
       CASE d.c WHEN 'FOOD' THEN 0 WHEN 'BEVERAGE' THEN 1 ELSE 2 END,
       now()
  FROM (SELECT DISTINCT category AS c FROM menu_items) d;
UPDATE menu_items SET category_id = 'mc_' || lower(category::text) WHERE category_id IS NULL;

ALTER TABLE "menu_items" ALTER COLUMN "category_id" SET NOT NULL;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "menu_items_category_idx" ON "menu_items"("category_id", "sort_order");

ALTER TABLE "menu_items"
    ADD CONSTRAINT menu_items_description_len CHECK (description IS NULL OR char_length(description) <= 300),
    ADD CONSTRAINT menu_items_prep_minutes CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 1 AND 240),
    ADD CONSTRAINT menu_items_alcohol_tax CHECK (tax_category = CASE WHEN is_alcoholic THEN 'OUTSIDE_GST' ELSE 'RESTAURANT' END),
    ADD CONSTRAINT menu_items_archived_status CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL)),
    ADD CONSTRAINT menu_items_photo_pair CHECK ((photo_url IS NULL) = (thumb_url IS NULL));

-- Item names are unique within a category, ignoring case (archived items don't count). Guarded: on an install where
-- two live items in one category already share a name, the index is skipped (the app still checks on every save)
-- and is created by re-running this statement once one of them is renamed or archived on the Menu screen:
--   CREATE UNIQUE INDEX menu_items_category_name_key ON menu_items (category_id, lower(btrim(name))) WHERE status <> 'ARCHIVED';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM menu_items WHERE status <> 'ARCHIVED' GROUP BY category_id, lower(btrim(name)) HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'menu_items_category_name_key skipped: duplicate item names in a category (see migration comment)';
  ELSE
    CREATE UNIQUE INDEX menu_items_category_name_key ON menu_items (category_id, lower(btrim(name))) WHERE status <> 'ARCHIVED';
  END IF;
END $$;

-- MN-2: the opening price of every existing item is the first row of its price-book history (as 0012 did for the
-- court and social fees), so the first change made from the Menu screen shows old → new.
INSERT INTO price_changes (id, target, price, effective_at, note, updated_at)
SELECT 'pc_menu_' || id, 'MENU:' || id, price, '2000-01-01T00:00:00Z', 'Opening price (menu item)', now()
  FROM menu_items
 WHERE NOT EXISTS (SELECT 1 FROM price_changes pc WHERE pc.target = 'MENU:' || menu_items.id);
