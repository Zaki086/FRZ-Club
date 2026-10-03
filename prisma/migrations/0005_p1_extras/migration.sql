-- Completion pass phase 5 (additive only): guardians, DPDP data requests, purchase orders, stock takes, barcodes.

ALTER TABLE "members" ADD COLUMN "guardian_name" TEXT;
ALTER TABLE "members" ADD COLUMN "guardian_phone" TEXT;
ALTER TABLE "members" ADD COLUMN "guardian_member_id" TEXT;
ALTER TABLE "members" ADD COLUMN "anonymised_at" TIMESTAMPTZ(3);
ALTER TABLE "members" ADD CONSTRAINT members_guardian_fk FOREIGN KEY ("guardian_member_id") REFERENCES "members"("id");
ALTER TABLE "members" ADD CONSTRAINT members_guardian_not_self CHECK (guardian_member_id IS NULL OR guardian_member_id <> id);
ALTER TABLE "members" ADD CONSTRAINT members_guardian_phone CHECK (guardian_phone IS NULL OR guardian_phone ~ '^[6-9][0-9]{9}$');
CREATE INDEX "members_guardian_member_id_idx" ON "members"("guardian_member_id");

ALTER TABLE "product_variants" ADD COLUMN "barcode" TEXT;
CREATE UNIQUE INDEX "product_variants_barcode_key" ON "product_variants"("barcode");
ALTER TABLE "product_variants" ADD CONSTRAINT product_variants_barcode CHECK (barcode IS NULL OR barcode ~ '^[0-9A-Za-z-]{4,32}$');

CREATE TABLE "data_requests" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "requested_by" TEXT,
    "handled_by" TEXT,
    "handled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT data_requests_member_fk FOREIGN KEY ("member_id") REFERENCES "members"("id"),
    CONSTRAINT data_requests_kind CHECK (kind IN ('EXPORT', 'ERASE')),
    CONSTRAINT data_requests_status CHECK (status IN ('OPEN', 'DONE', 'REJECTED'))
);
CREATE INDEX "data_requests_status_idx" ON "data_requests"("status");
-- One open request of each kind per member.
CREATE UNIQUE INDEX data_requests_one_open ON data_requests (member_id, kind) WHERE status = 'OPEN';

CREATE SEQUENCE purchase_order_code_seq;
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "expense_id" TEXT,
    "created_by" TEXT,
    "ordered_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT purchase_orders_status CHECK (status IN ('DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED')),
    CONSTRAINT purchase_orders_expense_fk FOREIGN KEY ("expense_id") REFERENCES "expense_bills"("id")
);
CREATE UNIQUE INDEX "purchase_orders_code_key" ON "purchase_orders"("code");
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_cost" INTEGER NOT NULL,
    "input_gst" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_order_lines_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT purchase_order_lines_variant_fk FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id"),
    CONSTRAINT purchase_order_lines_money CHECK (qty > 0 AND unit_cost >= 0 AND input_gst >= 0)
);

CREATE SEQUENCE stock_take_code_seq;
CREATE TABLE "stock_takes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "posted_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "stock_takes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stock_takes_code_key" ON "stock_takes"("code");
CREATE TABLE "stock_take_lines" (
    "id" TEXT NOT NULL,
    "stock_take_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "expected" INTEGER NOT NULL,
    "counted" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "stock_take_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stock_take_lines_stock_take_id_fkey" FOREIGN KEY ("stock_take_id") REFERENCES "stock_takes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT stock_take_lines_variant_fk FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id"),
    CONSTRAINT stock_take_lines_math CHECK (counted >= 0 AND delta = counted - expected)
);

-- Records are never deleted (the same guard as every other transactional table).
CREATE TRIGGER data_requests_no_delete BEFORE DELETE ON data_requests FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER purchase_order_lines_no_delete BEFORE DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER stock_takes_no_delete BEFORE DELETE ON stock_takes FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER stock_take_lines_no_delete BEFORE DELETE ON stock_take_lines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
