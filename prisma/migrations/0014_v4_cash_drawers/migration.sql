-- v4 §2 Cash Drawer v2 (additive only): physical tills, session status/approval, an append-only movement log per
-- session (live balance = Σ movements), the safe and bank deposits. Existing sessions are backfilled so every
-- session's movements reproduce what v3 recorded (float + cash taken − cash refunded, then the recorded variance).

-- ───────────── tills ─────────────
CREATE TABLE "cash_drawers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "default_float" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "cash_drawers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT cash_drawers_location CHECK (location IN ('FRONT_DESK', 'SHOP', 'BAR', 'OFFICE')),
    CONSTRAINT cash_drawers_default_float CHECK (default_float >= 0 AND default_float <= 10000000),
    CONSTRAINT cash_drawers_name_len CHECK (length(trim(name)) BETWEEN 2 AND 60)
);
CREATE UNIQUE INDEX cash_drawers_name_key ON cash_drawers (lower(name));
CREATE TRIGGER cash_drawers_no_delete BEFORE DELETE ON cash_drawers FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────────── sessions: till, status, counts, close split, approval ─────────────
ALTER TABLE "cash_drawer_sessions"
    ADD COLUMN "drawer_id" TEXT,
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN',
    ADD COLUMN "opening_counts" JSONB,
    ADD COLUMN "closing_counts" JSONB,
    ADD COLUMN "float_carried" INTEGER,
    ADD COLUMN "cash_dropped" INTEGER,
    ADD COLUMN "drop_ref" TEXT,
    ADD COLUMN "variance_reason" TEXT,
    ADD COLUMN "approved_by" TEXT,
    ADD COLUMN "approved_at" TIMESTAMPTZ(3),
    ADD COLUMN "rejected_by" TEXT,
    ADD COLUMN "rejected_at" TIMESTAMPTZ(3),
    ADD COLUMN "rejection_reason" TEXT;
ALTER TABLE cash_drawer_sessions ADD CONSTRAINT cash_drawer_sessions_drawer_fk FOREIGN KEY (drawer_id) REFERENCES cash_drawers(id);
ALTER TABLE cash_drawer_sessions ADD CONSTRAINT cash_drawer_sessions_close_split CHECK (
    (float_carried IS NULL OR float_carried >= 0) AND (cash_dropped IS NULL OR cash_dropped >= 0));

-- Existing sessions: closed ones are CLOSED (v3 had no approval step), open ones stay OPEN.
UPDATE cash_drawer_sessions SET status = CASE WHEN closed_at IS NULL THEN 'OPEN' ELSE 'CLOSED' END;

-- One till per area that has sessions (named like the tills the Owner adds), default float = the latest float used
-- there. A till holds one open session, so each further session open right now gets its own numbered till.
DO $$
DECLARE
  a record;
  s record;
  n int;
  loc text;
  base text;
  first_name text;
  till text;
BEGIN
  FOR a IN SELECT DISTINCT area FROM cash_drawer_sessions ORDER BY area LOOP
    loc := CASE a.area WHEN 'DESK' THEN 'FRONT_DESK' WHEN 'SHOP' THEN 'SHOP' WHEN 'BAR' THEN 'BAR' ELSE 'OFFICE' END;
    base := CASE loc WHEN 'FRONT_DESK' THEN 'Front Desk Till' WHEN 'SHOP' THEN 'Shop Till' WHEN 'BAR' THEN 'Bar Till' ELSE 'Office Till' END;
    first_name := CASE loc WHEN 'FRONT_DESK' THEN 'Front Desk Till 1' ELSE base END;
    till := 'till_' || lower(a.area) || '_1';
    INSERT INTO cash_drawers (id, name, location, default_float, active, updated_at)
    VALUES (till, first_name, loc,
            LEAST(10000000, COALESCE((SELECT opening_float FROM cash_drawer_sessions WHERE area = a.area ORDER BY opened_at DESC LIMIT 1), 0)),
            true, now());
    UPDATE cash_drawer_sessions SET drawer_id = till WHERE area = a.area;
    n := 1;
    FOR s IN SELECT id, opening_float FROM cash_drawer_sessions WHERE area = a.area AND closed_at IS NULL ORDER BY opened_at, id OFFSET 1 LOOP
      n := n + 1;
      till := 'till_' || lower(a.area) || '_' || n;
      INSERT INTO cash_drawers (id, name, location, default_float, active, updated_at)
      VALUES (till, base || ' ' || n, loc, LEAST(10000000, s.opening_float), true, now());
      UPDATE cash_drawer_sessions SET drawer_id = till WHERE id = s.id;
    END LOOP;
  END LOOP;
END $$;

-- CD rule: at most one OPEN session per till (one per staff member already exists: cash_drawer_one_open_per_user).
CREATE UNIQUE INDEX cash_drawer_one_open_per_drawer ON cash_drawer_sessions (drawer_id) WHERE closed_at IS NULL;
CREATE INDEX cash_drawer_sessions_drawer_idx ON cash_drawer_sessions (drawer_id, opened_at);
CREATE INDEX cash_drawer_sessions_pending_idx ON cash_drawer_sessions (status) WHERE status = 'PENDING_APPROVAL';
ALTER TABLE cash_drawer_sessions ADD CONSTRAINT cash_drawer_sessions_status CHECK (status IN ('OPEN', 'PENDING_APPROVAL', 'CLOSED', 'APPROVED', 'REJECTED'));
-- A session with a close time is never OPEN (rows written without a status get the right one).
CREATE OR REPLACE FUNCTION cash_drawer_session_status() RETURNS trigger AS $$
BEGIN
  IF NEW.closed_at IS NOT NULL AND NEW.status = 'OPEN' THEN
    NEW.status := 'CLOSED';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_drawer_sessions_status BEFORE INSERT OR UPDATE ON cash_drawer_sessions
  FOR EACH ROW EXECUTE FUNCTION cash_drawer_session_status();
ALTER TABLE cash_drawer_sessions ADD CONSTRAINT cash_drawer_sessions_status_open CHECK ((status = 'OPEN') = (closed_at IS NULL));

-- ───────────── movements (append-only, like the ledger) ─────────────
CREATE TABLE "drawer_movements" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "at_close" BOOLEAN NOT NULL DEFAULT false,
    "payment_id" TEXT,
    "expense_id" TEXT,
    "reference" TEXT,
    "category" TEXT,
    "actor_id" TEXT,
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    CONSTRAINT "drawer_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT drawer_movements_session_fk FOREIGN KEY (session_id) REFERENCES cash_drawer_sessions(id),
    CONSTRAINT drawer_movements_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id),
    CONSTRAINT drawer_movements_expense_fk FOREIGN KEY (expense_id) REFERENCES expense_bills(id),
    CONSTRAINT drawer_movements_line UNIQUE (session_id, line_no),
    CONSTRAINT drawer_movements_line_pos CHECK (line_no >= 1),
    CONSTRAINT drawer_movements_type CHECK (type IN ('OPENING_FLOAT', 'CASH_SALE', 'CASH_REFUND', 'PAY_IN', 'PAY_OUT', 'CASH_DROP', 'CLOSING_ADJUSTMENT')),
    CONSTRAINT drawer_movements_sign CHECK (
        (type = 'OPENING_FLOAT' AND amount >= 0) OR
        (type IN ('CASH_SALE', 'PAY_IN') AND amount > 0) OR
        (type IN ('CASH_REFUND', 'PAY_OUT', 'CASH_DROP') AND amount < 0) OR
        (type = 'CLOSING_ADJUSTMENT' AND amount <> 0)),
    -- CD-1/CD-2: every sale and refund movement points at its payment; nothing else does.
    CONSTRAINT drawer_movements_payment_link CHECK ((type IN ('CASH_SALE', 'CASH_REFUND')) = (payment_id IS NOT NULL)),
    CONSTRAINT drawer_movements_expense_link CHECK (expense_id IS NULL OR type = 'PAY_OUT')
);
CREATE UNIQUE INDEX drawer_movements_payment_key ON drawer_movements (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX drawer_movements_at_idx ON drawer_movements (at);
CREATE INDEX drawer_movements_type_idx ON drawer_movements (type, at);
CREATE TRIGGER drawer_movements_append_only BEFORE UPDATE OR DELETE ON drawer_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Backfill: every existing session gets OPENING_FLOAT, one CASH_SALE per linked successful cash payment, one
-- CASH_REFUND per linked successful cash refund (in time order), then its recorded variance as CLOSING_ADJUSTMENT.
INSERT INTO drawer_movements (id, session_id, line_no, type, amount, balance_after, at_close, payment_id, reference, actor_id, note, at, created_at)
SELECT 'dm_' || md5(x.session_id || ':' || x.k),
       x.session_id,
       row_number() OVER w,
       x.type, x.amount,
       sum(x.amount) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
       x.at_close, x.payment_id, x.reference, x.actor_id, x.note, x.at, now()
  FROM (
    SELECT d.id AS session_id, 'open' AS k, 0 AS ord, 'OPENING_FLOAT' AS type, d.opening_float AS amount, false AS at_close,
           NULL::text AS payment_id, NULL::text AS reference, d.user_id AS actor_id, 'Opening float' AS note, d.opened_at AS at
      FROM cash_drawer_sessions d
    UNION ALL
    SELECT p.drawer_session_id, 'p:' || p.id, 1,
           CASE p.type WHEN 'PAYMENT' THEN 'CASH_SALE' ELSE 'CASH_REFUND' END,
           CASE p.type WHEN 'PAYMENT' THEN p.amount ELSE -p.amount END, false,
           p.id, NULL, p.received_by, NULL, p.occurred_at
      FROM payments p
     WHERE p.drawer_session_id IS NOT NULL AND p.method = 'CASH' AND p.status = 'SUCCEEDED' AND p.amount > 0
    UNION ALL
    SELECT d.id, 'adj', 2, 'CLOSING_ADJUSTMENT', d.variance, true, NULL, NULL, COALESCE(d.closed_by, d.user_id),
           COALESCE('Variance at close · ' || d.note, 'Variance at close'), d.closed_at
      FROM cash_drawer_sessions d
     WHERE d.closed_at IS NOT NULL AND COALESCE(d.variance, 0) <> 0
  ) x
WINDOW w AS (PARTITION BY x.session_id ORDER BY x.ord, x.at, x.k);

-- ───────────── safe and bank deposits ─────────────
CREATE TABLE "bank_deposits" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "deposit_date" DATE NOT NULL,
    "slip_ref" TEXT NOT NULL,
    "photo_url" TEXT,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SAFE',
    "session_id" TEXT,
    "recorded_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "bank_deposits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT bank_deposits_amount CHECK (amount > 0),
    CONSTRAINT bank_deposits_source CHECK (source IN ('SAFE', 'SESSION')),
    CONSTRAINT bank_deposits_session_fk FOREIGN KEY (session_id) REFERENCES cash_drawer_sessions(id)
);
CREATE INDEX bank_deposits_date_idx ON bank_deposits (deposit_date);
CREATE TRIGGER bank_deposits_no_delete BEFORE DELETE ON bank_deposits FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- §2.6: safe balance = Σ cash drops − Σ pay-ins from the safe − Σ bank deposits (each row carries the running balance).
CREATE TABLE "safe_movements" (
    "id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "drawer_movement_id" TEXT,
    "bank_deposit_id" TEXT,
    "reference" TEXT,
    "actor_id" TEXT,
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    CONSTRAINT "safe_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT safe_movements_line UNIQUE (line_no),
    CONSTRAINT safe_movements_type CHECK (type IN ('CASH_DROP', 'PAY_IN', 'BANK_DEPOSIT')),
    CONSTRAINT safe_movements_sign CHECK ((type = 'CASH_DROP' AND amount > 0) OR (type IN ('PAY_IN', 'BANK_DEPOSIT') AND amount < 0)),
    CONSTRAINT safe_movements_nonneg CHECK (balance_after >= 0),
    CONSTRAINT safe_movements_drawer_fk FOREIGN KEY (drawer_movement_id) REFERENCES drawer_movements(id),
    CONSTRAINT safe_movements_deposit_fk FOREIGN KEY (bank_deposit_id) REFERENCES bank_deposits(id),
    CONSTRAINT safe_movements_link CHECK ((type = 'BANK_DEPOSIT') = (bank_deposit_id IS NOT NULL) AND (type <> 'BANK_DEPOSIT') = (drawer_movement_id IS NOT NULL))
);
CREATE UNIQUE INDEX safe_movements_drawer_key ON safe_movements (drawer_movement_id) WHERE drawer_movement_id IS NOT NULL;
CREATE UNIQUE INDEX safe_movements_deposit_key ON safe_movements (bank_deposit_id) WHERE bank_deposit_id IS NOT NULL;
CREATE INDEX safe_movements_at_idx ON safe_movements (at);
CREATE TRIGGER safe_movements_append_only BEFORE UPDATE OR DELETE ON safe_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
