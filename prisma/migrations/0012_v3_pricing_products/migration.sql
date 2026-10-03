-- v3 phase 7 (additive only): the price book (§9.2) and product photos (§9.3).

-- PR-12: every base price change is a dated version; the latest one in effect wins. Targets:
-- COURT_FEE:<TIER>:<SPORT>, SOCIAL_FEE:<TIER>, VARIANT:<id>, MENU:<id>.
CREATE TABLE "price_changes" (
    "id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "price_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT price_changes_price CHECK (price >= 0),
    CONSTRAINT price_changes_target CHECK (target ~ '^(COURT_FEE:(GOLD|SILVER|JUNIOR|WALK_IN):(TENNIS|CRICKET|PADEL|BADMINTON)|SOCIAL_FEE:(GOLD|SILVER|JUNIOR|WALK_IN)|VARIANT:.+|MENU:.+)$')
);
CREATE INDEX "price_changes_target_idx" ON "price_changes"("target", "effective_at" DESC);

-- The court and social fees move into the price book: today's values become the opening version.
INSERT INTO price_changes (id, target, price, effective_at, note, updated_at)
SELECT 'pc_' || p.code || '_' || f.sport, 'COURT_FEE:' || p.code || ':' || f.sport, f.fee, '2000-01-01T00:00:00Z', 'Opening price (from the plan)', now()
  FROM plan_court_fees f JOIN plans p ON p.id = f.plan_id;
INSERT INTO price_changes (id, target, price, effective_at, note, updated_at)
SELECT 'pc_' || code || '_social', 'SOCIAL_FEE:' || code, social_fee, '2000-01-01T00:00:00Z', 'Opening price (from the plan)', now() FROM plans;
INSERT INTO price_changes (id, target, price, effective_at, note, updated_at)
SELECT 'pc_WALK_IN_' || kv.key, 'COURT_FEE:WALK_IN:' || kv.key, (kv.value)::int, '2000-01-01T00:00:00Z', 'Opening price (walk-in setting)', now()
  FROM settings s, jsonb_each_text(s.value -> 'court_fee') kv WHERE s.key = 'walk_in';
INSERT INTO price_changes (id, target, price, effective_at, note, updated_at)
SELECT 'pc_WALK_IN_social', 'SOCIAL_FEE:WALK_IN', (s.value ->> 'social_fee')::int, '2000-01-01T00:00:00Z', 'Opening price (walk-in setting)', now()
  FROM settings s WHERE s.key = 'walk_in' AND s.value ? 'social_fee';

-- Time bands, special dates and promotions. Never edited in place: a change ends the old version and starts a new one.
CREATE SEQUENCE price_rule_code_seq;
CREATE TABLE "price_rules" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "sports" TEXT[] NOT NULL DEFAULT '{}',
    "court_ids" TEXT[] NOT NULL DEFAULT '{}',
    "product_categories" TEXT[] NOT NULL DEFAULT '{}',
    "product_ids" TEXT[] NOT NULL DEFAULT '{}',
    "menu_categories" TEXT[] NOT NULL DEFAULT '{}',
    "menu_item_ids" TEXT[] NOT NULL DEFAULT '{}',
    "days_of_week" INTEGER[] NOT NULL DEFAULT '{}',
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "date_from" DATE,
    "date_to" DATE,
    "adjust_type" TEXT NOT NULL,
    "adjust_pct" INTEGER,
    "fixed_prices" JSONB,
    "flat_amount" INTEGER,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "tiers" TEXT[] NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "effective_to" TIMESTAMPTZ(3),
    "replaces_id" TEXT,
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "price_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT price_rules_replaces_fkey FOREIGN KEY ("replaces_id") REFERENCES "price_rules"("id"),
    CONSTRAINT price_rules_kind CHECK (kind IN ('BAND', 'SPECIAL_DATE', 'PROMOTION')),
    CONSTRAINT price_rules_scope CHECK (scope IN ('COURTS', 'SOCIAL', 'PRODUCTS', 'MENU')),
    CONSTRAINT price_rules_adjust CHECK (adjust_type IN ('PCT', 'FIXED', 'FLAT')),
    CONSTRAINT price_rules_audience CHECK (audience IN ('ALL', 'TIERS', 'WALK_IN')),
    CONSTRAINT price_rules_status CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'ENDED')),
    CONSTRAINT price_rules_window CHECK ((start_minute IS NULL) = (end_minute IS NULL) AND (start_minute IS NULL OR (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute))),
    CONSTRAINT price_rules_dates CHECK (date_from IS NULL OR date_to IS NULL OR date_to >= date_from),
    CONSTRAINT price_rules_effective CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX "price_rules_code_key" ON "price_rules"("code");
CREATE INDEX "price_rules_active_idx" ON "price_rules"("kind", "scope", "status");

-- §9.3: up to five photos per product, first = cover; a 1200 px image and a 400 px thumbnail each.
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumb_url" TEXT NOT NULL,
    "sort" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id"),
    CONSTRAINT product_images_product_fkey FOREIGN KEY ("product_id") REFERENCES "products"("id")
);
CREATE INDEX "product_images_product_idx" ON "product_images"("product_id", "sort");
-- Products that already had a photo keep it as their cover.
INSERT INTO product_images (id, product_id, url, thumb_url, sort, updated_at)
SELECT 'pi_' || id, id, image_url, image_url, 0, now() FROM products WHERE image_url IS NOT NULL;

CREATE TRIGGER price_changes_no_delete BEFORE DELETE ON price_changes FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER price_rules_no_delete BEFORE DELETE ON price_rules FOR EACH ROW EXECUTE FUNCTION forbid_delete();
