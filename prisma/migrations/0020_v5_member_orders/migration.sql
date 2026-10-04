-- v5 §1.2–1.3 (ORDER): members order from the portal "Bar & Café" onto their own bar tab (additive only).
-- MO-1  The table QR (`/t/<TBL1 token>`) is remembered on the member's login session: which table, the verified
--       token and when it was scanned (valid for 3 hours, checked against the business clock).
-- MO-2/MO-3  A member order is a batch of lines a member put on their OPEN tab from the app. It waits for the bar
--       (PENDING) until bar staff accept it (ACCEPTED: its lines go to the kitchen as one ticket) or reject it with a
--       reason (REJECTED: its lines are voided). CANCELLED: the member removed every line before it was accepted.
-- MO-10 Tab lines say where they came from: `member_order_id` set = "via app", empty = "by staff".

-- ───────────── MO-1: table scan on the session ─────────────
ALTER TABLE "sessions"
    ADD COLUMN "table_id" TEXT,
    ADD COLUMN "table_token" TEXT,
    ADD COLUMN "table_scanned_at" TIMESTAMPTZ(3);
ALTER TABLE "sessions" ADD CONSTRAINT sessions_table_fk FOREIGN KEY ("table_id") REFERENCES "bar_tables"("id");
ALTER TABLE "sessions" ADD CONSTRAINT sessions_table_scan_complete CHECK (("table_id" IS NULL) = ("table_scanned_at" IS NULL));

-- ───────────── MO-2/MO-3: member orders ─────────────
CREATE TABLE "member_orders" (
    "id" TEXT NOT NULL,
    "tab_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "placed_by" TEXT NOT NULL,
    "table_id" TEXT,
    "via_table_scan" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "auto_accepted" BOOLEAN NOT NULL DEFAULT false,
    "total" INTEGER NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "reject_note" TEXT,
    "kitchen_ticket_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "member_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT member_orders_status CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT member_orders_total CHECK ("total" >= 0),
    CONSTRAINT member_orders_reject_reason CHECK ("reject_reason" IS NULL OR "reject_reason" IN ('ITEM_UNAVAILABLE', 'MEMBER_NOT_FOUND', 'OTHER')),
    CONSTRAINT member_orders_rejected_has_reason CHECK ("status" <> 'REJECTED' OR "reject_reason" IS NOT NULL),
    CONSTRAINT member_orders_decided CHECK ("status" = 'PENDING' OR "decided_at" IS NOT NULL),
    CONSTRAINT member_orders_accepted_ticket CHECK ("status" <> 'ACCEPTED' OR "kitchen_ticket_id" IS NOT NULL)
);
ALTER TABLE "member_orders" ADD CONSTRAINT member_orders_tab_fk FOREIGN KEY ("tab_id") REFERENCES "tabs"("id");
ALTER TABLE "member_orders" ADD CONSTRAINT member_orders_member_fk FOREIGN KEY ("member_id") REFERENCES "members"("id");
ALTER TABLE "member_orders" ADD CONSTRAINT member_orders_placed_by_fk FOREIGN KEY ("placed_by") REFERENCES "users"("id");
ALTER TABLE "member_orders" ADD CONSTRAINT member_orders_table_fk FOREIGN KEY ("table_id") REFERENCES "bar_tables"("id");
ALTER TABLE "member_orders" ADD CONSTRAINT member_orders_ticket_fk FOREIGN KEY ("kitchen_ticket_id") REFERENCES "kitchen_tickets"("id");
CREATE INDEX "member_orders_pending_idx" ON "member_orders"("created_at") WHERE "status" = 'PENDING';
CREATE INDEX "member_orders_tab_idx" ON "member_orders"("tab_id");
CREATE INDEX "member_orders_member_idx" ON "member_orders"("member_id", "created_at");
CREATE TRIGGER member_orders_no_delete BEFORE DELETE ON member_orders FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────────── MO-10: "via app" lines ─────────────
ALTER TABLE "tab_lines" ADD COLUMN "member_order_id" TEXT;
ALTER TABLE "tab_lines" ADD CONSTRAINT tab_lines_member_order_fk FOREIGN KEY ("member_order_id") REFERENCES "member_orders"("id");
CREATE INDEX "tab_lines_member_order_idx" ON "tab_lines"("member_order_id") WHERE "member_order_id" IS NOT NULL;
