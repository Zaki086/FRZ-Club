-- Completion pass (additive only): KITCHEN role, BANK_TRANSFER, PAY_ON_DELIVERY, cash drawer sessions,
-- message log, account security fields, consent timestamps, GST category update.

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'KITCHEN';

-- AlterEnum
ALTER TYPE "PaymentOption" ADD VALUE 'PAY_ON_DELIVERY';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'BANK_TRANSFER';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_login_at" TIMESTAMPTZ(3),
ADD COLUMN     "locked_until" TIMESTAMPTZ(3),
ADD COLUMN     "password_changed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "password_set_tokens" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'SET';

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "consent_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "approval_code" TEXT,
ADD COLUMN     "card_last4" TEXT,
ADD COLUMN     "drawer_session_id" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "consent_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "cash_drawer_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "opening_float" INTEGER NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" TEXT,
    "cash_expected" INTEGER,
    "cash_counted" INTEGER,
    "variance" INTEGER,
    "card_total" INTEGER,
    "upi_total" INTEGER,
    "note" TEXT,
    "deposit_amount" INTEGER,
    "deposit_ref" TEXT,
    "deposited_at" TIMESTAMPTZ(3),
    "deposited_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_drawer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_log" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "entity" TEXT,
    "entity_id" TEXT,
    "actor_id" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_drawer_sessions_user_id_closed_at_idx" ON "cash_drawer_sessions"("user_id", "closed_at");

-- CreateIndex
CREATE INDEX "message_log_at_idx" ON "message_log"("at");


-- ───────────── guarantees for the new tables ─────────────
ALTER TABLE cash_drawer_sessions ADD CONSTRAINT cash_drawer_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE cash_drawer_sessions ADD CONSTRAINT cash_drawer_float_nonneg CHECK (opening_float >= 0);
-- 8.4: at most one open drawer per staff member
CREATE UNIQUE INDEX cash_drawer_one_open_per_user ON cash_drawer_sessions (user_id) WHERE closed_at IS NULL;
ALTER TABLE payments ADD CONSTRAINT payments_drawer_fk FOREIGN KEY (drawer_session_id) REFERENCES cash_drawer_sessions(id);
ALTER TABLE payments ADD CONSTRAINT payments_card_last4_format CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$');
CREATE TRIGGER cash_drawer_sessions_no_delete BEFORE DELETE ON cash_drawer_sessions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER message_log_append_only BEFORE UPDATE OR DELETE ON message_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────── §9.2 GST categories ─────────────
-- The 12 % goods slab no longer exists: sports goods and apparel/footwear up to ₹2,500 → 5 %, other goods → 18 %.
-- Rates stay unverified until the Owner confirms them.
UPDATE product_variants v SET tax_category = CASE
    WHEN v.hsn_sac LIKE '9506%' THEN 'GOODS_5'
    WHEN p.category IN ('APPAREL', 'SHOES') AND v.price <= 250000 THEN 'GOODS_5'
    ELSE 'GOODS_18' END
  FROM products p WHERE p.id = v.product_id AND v.tax_category = 'GOODS';
-- Alcohol for human consumption is outside GST (state excise/VAT, not modelled).
UPDATE menu_items SET tax_category = 'OUTSIDE_GST' WHERE tax_category = 'ALCOHOL';
UPDATE settings SET value = (value - 'GOODS' - 'ALCOHOL') || '{"GOODS_5": 5, "GOODS_18": 18, "OUTSIDE_GST": 0}'::jsonb,
                    verified = false
 WHERE key = 'tax_rates';
