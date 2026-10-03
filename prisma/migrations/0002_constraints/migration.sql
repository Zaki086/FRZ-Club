-- Raw SQL for the guarantees Prisma cannot express (plan.md §1, §5, §6, §9).
-- Every rule ID below is enforced by the database itself, independently of the application code.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────────── Injectable clock for created_at (plan §1.1 rule 5) ─────────────
-- Services set `app.now` (transaction-local) from the injectable clock, so rows created by the
-- 60-day seed carry their historical timestamps. Outside a service transaction it falls back to now().
CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz AS $$
  SELECT coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now())
$$ LANGUAGE sql STABLE;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND column_name = 'created_at'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN created_at SET DEFAULT app_now()', t);
  END LOOP;
END $$;

-- ───────────── BK-1: no two parties on the same court at the same time ─────────────
ALTER TABLE court_reservations
  ADD CONSTRAINT court_reservations_end_after_start CHECK (end_at > start_at);
ALTER TABLE court_reservations
  ADD COLUMN period tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED;
ALTER TABLE court_reservations ADD CONSTRAINT no_court_overlap
  EXCLUDE USING gist (court_id WITH =, period WITH &&)
  WHERE (status <> 'CANCELLED');

-- ───────────── ST-2: no overlapping assigned shifts per employee ─────────────
ALTER TABLE shifts ADD CONSTRAINT shifts_end_after_start CHECK (end_at > start_at);
ALTER TABLE shifts
  ADD COLUMN period tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED;
ALTER TABLE shifts ADD CONSTRAINT no_shift_overlap
  EXCLUDE USING gist (employee_id WITH =, period WITH &&)
  WHERE (status = 'ASSIGNED');
ALTER TABLE shifts ADD CONSTRAINT shifts_assigned_has_employee
  CHECK (status <> 'ASSIGNED' OR employee_id IS NOT NULL);

-- ───────────── SH-2: stock can never go negative or be over-reserved ─────────────
ALTER TABLE product_variants ADD CONSTRAINT variant_on_hand_nonneg CHECK (on_hand >= 0);
ALTER TABLE product_variants ADD CONSTRAINT variant_reserved_nonneg CHECK (reserved >= 0);
ALTER TABLE product_variants ADD CONSTRAINT variant_reserved_le_on_hand CHECK (reserved <= on_hand);
ALTER TABLE product_variants ADD CONSTRAINT variant_price_nonneg CHECK (price >= 0);

-- ───────────── Exactly-one-of checks (§6) ─────────────
ALTER TABLE bookings ADD CONSTRAINT bookings_one_primary
  CHECK ((primary_member_id IS NULL) <> (primary_guest_id IS NULL));
ALTER TABLE booking_players ADD CONSTRAINT booking_players_one_person
  CHECK ((member_id IS NULL) <> (guest_id IS NULL));
ALTER TABLE social_participants ADD CONSTRAINT social_participants_one_person
  CHECK ((member_id IS NULL) <> (guest_id IS NULL));
ALTER TABLE tabs ADD CONSTRAINT tabs_one_payer
  CHECK ((member_id IS NULL) <> (guest_id IS NULL));
ALTER TABLE visits ADD CONSTRAINT visits_one_person
  CHECK ((member_id IS NULL) <> (guest_id IS NULL));

-- Unique player per booking (removed players are kept for history, BK-8)
CREATE UNIQUE INDEX booking_players_member_uq ON booking_players (booking_id, member_id)
  WHERE member_id IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX booking_players_guest_uq ON booking_players (booking_id, guest_id)
  WHERE guest_id IS NOT NULL AND removed_at IS NULL;

-- Unique participant per social session (SP-3)
CREATE UNIQUE INDEX social_participants_member_uq ON social_participants (session_id, member_id)
  WHERE member_id IS NOT NULL AND status = 'JOINED';
CREATE UNIQUE INDEX social_participants_guest_uq ON social_participants (session_id, guest_id)
  WHERE guest_id IS NOT NULL AND status = 'JOINED';

-- ───────────── MB-5: at most one ACTIVE and one SCHEDULED membership per member ─────────────
CREATE UNIQUE INDEX memberships_one_active ON memberships (member_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX memberships_one_scheduled ON memberships (member_id) WHERE status = 'SCHEDULED';
-- D-08: a same-day upgrade ends the old membership 'yesterday' (= start − 1) with status CHANGED.
ALTER TABLE memberships ADD CONSTRAINT memberships_dates
  CHECK (end_date >= start_date OR (status = 'CHANGED' AND end_date = start_date - 1));
ALTER TABLE memberships ADD CONSTRAINT memberships_price_nonneg CHECK (price >= 0 AND credit_applied >= 0);

-- ───────────── BR-3: one OPEN tab per member ─────────────
CREATE UNIQUE INDEX tabs_one_open_per_member ON tabs (member_id) WHERE status = 'OPEN' AND member_id IS NOT NULL;

-- ───────────── CR-8: one trial per phone (guest) ─────────────
CREATE UNIQUE INDEX bookings_one_trial_per_guest ON bookings (primary_guest_id)
  WHERE channel = 'ONLINE_TRIAL' AND status <> 'CANCELLED';

-- ───────────── PY-1 / PY-4: money sanity ─────────────
ALTER TABLE bills ADD CONSTRAINT bills_money CHECK (
  total >= 0 AND amount_paid >= 0 AND amount_refunded >= 0
  AND amount_refunded <= amount_paid AND amount_paid - amount_refunded <= total);
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_out_is_negative CHECK (direction = 'IN' OR amount < 0);
ALTER TABLE bill_lines ADD CONSTRAINT bill_lines_qty_positive CHECK (qty > 0);
ALTER TABLE tab_lines ADD CONSTRAINT tab_lines_qty_positive CHECK (qty > 0);
ALTER TABLE shop_order_lines ADD CONSTRAINT shop_order_lines_qty_positive CHECK (qty > 0);
ALTER TABLE expense_bills ADD CONSTRAINT expense_amount_positive CHECK (amount > 0 AND input_gst >= 0);

-- ───────────── Foreign keys for id columns not modelled as Prisma relations ─────────────
ALTER TABLE bookings ADD CONSTRAINT bookings_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE bookings ADD CONSTRAINT bookings_member_fk FOREIGN KEY (primary_member_id) REFERENCES members(id);
ALTER TABLE bookings ADD CONSTRAINT bookings_guest_fk FOREIGN KEY (primary_guest_id) REFERENCES guests(id);
ALTER TABLE booking_players ADD CONSTRAINT booking_players_member_fk FOREIGN KEY (member_id) REFERENCES members(id);
ALTER TABLE booking_players ADD CONSTRAINT booking_players_guest_fk FOREIGN KEY (guest_id) REFERENCES guests(id);
ALTER TABLE social_participants ADD CONSTRAINT social_participants_member_fk FOREIGN KEY (member_id) REFERENCES members(id);
ALTER TABLE social_participants ADD CONSTRAINT social_participants_guest_fk FOREIGN KEY (guest_id) REFERENCES guests(id);
ALTER TABLE social_participants ADD CONSTRAINT social_participants_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE social_session_courts ADD CONSTRAINT social_session_courts_court_fk FOREIGN KEY (court_id) REFERENCES courts(id);
ALTER TABLE memberships ADD CONSTRAINT memberships_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_variant_fk FOREIGN KEY (variant_id) REFERENCES product_variants(id);
ALTER TABLE counter_sales ADD CONSTRAINT counter_sales_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE shop_order_lines ADD CONSTRAINT shop_order_lines_variant_fk FOREIGN KEY (variant_id) REFERENCES product_variants(id);
ALTER TABLE service_tickets ADD CONSTRAINT service_tickets_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE tabs ADD CONSTRAINT tabs_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE tabs ADD CONSTRAINT tabs_member_fk FOREIGN KEY (member_id) REFERENCES members(id);
ALTER TABLE tabs ADD CONSTRAINT tabs_guest_fk FOREIGN KEY (guest_id) REFERENCES guests(id);
ALTER TABLE tabs ADD CONSTRAINT tabs_table_fk FOREIGN KEY (table_id) REFERENCES bar_tables(id);
ALTER TABLE tab_lines ADD CONSTRAINT tab_lines_menu_fk FOREIGN KEY (menu_item_id) REFERENCES menu_items(id);
ALTER TABLE tab_lines ADD CONSTRAINT tab_lines_bill_line_fk FOREIGN KEY (bill_line_id) REFERENCES bill_lines(id);
ALTER TABLE tab_lines ADD CONSTRAINT tab_lines_ticket_fk FOREIGN KEY (kitchen_ticket_id) REFERENCES kitchen_tickets(id);
ALTER TABLE kitchen_tickets ADD CONSTRAINT kitchen_tickets_tab_fk FOREIGN KEY (tab_id) REFERENCES tabs(id);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id);
ALTER TABLE payments ADD CONSTRAINT payments_refund_of_fk FOREIGN KEY (refund_of_id) REFERENCES payments(id);
ALTER TABLE payments ADD CONSTRAINT payments_shift_fk FOREIGN KEY (shift_id) REFERENCES attendance(id);
ALTER TABLE invoices ADD CONSTRAINT invoices_bill_fk FOREIGN KEY (bill_id) REFERENCES bills(id);
ALTER TABLE invoices ADD CONSTRAINT invoices_client_fk FOREIGN KEY (business_client_id) REFERENCES business_clients(id);
ALTER TABLE invoices ADD CONSTRAINT invoices_member_fk FOREIGN KEY (member_id) REFERENCES members(id);
ALTER TABLE leads ADD CONSTRAINT leads_assignee_fk FOREIGN KEY (assigned_to) REFERENCES users(id);
ALTER TABLE leads ADD CONSTRAINT leads_member_fk FOREIGN KEY (member_id) REFERENCES members(id);
ALTER TABLE shifts ADD CONSTRAINT shifts_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id);
ALTER TABLE attendance ADD CONSTRAINT attendance_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id);
ALTER TABLE leave_requests ADD CONSTRAINT leave_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id);
ALTER TABLE payslips ADD CONSTRAINT payslips_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id);

-- ───────────── Human-readable codes from sequences (§2) ─────────────
CREATE SEQUENCE member_code_seq;
CREATE SEQUENCE booking_code_seq;
CREATE SEQUENCE shop_order_code_seq;
CREATE SEQUENCE counter_sale_code_seq;
CREATE SEQUENCE tab_code_seq;
CREATE SEQUENCE lead_code_seq;
CREATE SEQUENCE service_ticket_code_seq;

-- ───────────── Append-only tables (PY-5, SH-3, audit) ─────────────
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- PR-8: bill lines are snapshots. Only the void marker may change.
CREATE OR REPLACE FUNCTION bill_lines_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bill_lines rows cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.bill_id, NEW.description, NEW.qty, NEW.unit_price, NEW.discount_pct, NEW.discount_amount,
      NEW.net_amount, NEW.tax_rate, NEW.tax_amount, NEW.tax_category, NEW.hsn_sac, NEW.explanation)
     IS DISTINCT FROM
     (OLD.bill_id, OLD.description, OLD.qty, OLD.unit_price, OLD.discount_pct, OLD.discount_amount,
      OLD.net_amount, OLD.tax_rate, OLD.tax_amount, OLD.tax_category, OLD.hsn_sac, OLD.explanation) THEN
    RAISE EXCEPTION 'bill_lines are immutable snapshots (PR-8)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bill_lines_snapshot BEFORE UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION bill_lines_immutable();

-- ───────────── §2 / §9.10: no hard deletes of transactional records ─────────────
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'hard delete of % is not allowed; cancel, void or archive instead', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'members','guests','memberships','visits','court_reservations','bookings','booking_players',
    'social_sessions','social_session_courts','social_participants','counter_sales','shop_orders',
    'shop_order_lines','shop_order_events','service_tickets','tabs','tab_lines','kitchen_tickets','bar_days',
    'bills','payments','invoices','leads','lead_activities','quotes','shifts','attendance',
    'leave_requests','payroll_runs','payslips','expense_bills','products','product_variants',
    'plans','courts','menu_items','business_clients'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_delete()',
                   t || '_no_delete', t);
  END LOOP;
END $$;

-- Helpful indexes for rule checks and reports
CREATE INDEX court_reservations_period_idx ON court_reservations USING gist (period);
CREATE INDEX bills_created_idx ON bills (created_at);
CREATE INDEX leads_follow_up_idx ON leads (next_follow_up_at) WHERE status NOT IN ('WON','LOST');
