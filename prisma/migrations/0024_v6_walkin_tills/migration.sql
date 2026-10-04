-- v6 §4 (SHOP) — walk-in sales and receipt-code refunds. Additive only; safe on the live data.

-- WI-4: who a bill is for, made explicit. A bill's customer is a member, a business client, a guest (a walk-in who
-- left a phone, or a named bar/booking guest) or nobody — an anonymous walk-in sale (`WALK_IN`, no person attached).
-- Derived by the database from the existing columns, so it can never disagree with them and every existing bill is
-- classified on the spot (no backfill to run, nothing for the application to keep in step).
ALTER TABLE bills ADD COLUMN customer_kind text GENERATED ALWAYS AS (
  CASE
    WHEN member_id IS NOT NULL THEN 'MEMBER'
    WHEN business_client_id IS NOT NULL THEN 'BUSINESS'
    WHEN guest_id IS NOT NULL THEN 'GUEST'
    ELSE 'WALK_IN'
  END
) STORED;
CREATE INDEX bills_customer_kind_idx ON bills (customer_kind) WHERE customer_kind = 'WALK_IN';

-- WI-5: a refund on an anonymous walk-in sale is paid out against the receipt — its code typed in (RECEIPT_CODE) or
-- its signed receipt QR scanned (RECEIPT_QR). The v4 identity-method list gains those two values.
ALTER TABLE refund_requests DROP CONSTRAINT refund_requests_identity_method;
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_identity_method CHECK (
  "identity_method" IS NULL OR "identity_method" IN ('REFUND_QR', 'MEMBER_CARD', 'SEARCH', 'GUEST_PHONE_CODE', 'RECEIPT_QR', 'RECEIPT_CODE')
);

-- TL-4: tills are already unique by name, case-insensitively (cash_drawers_name_key, 0014); creation by name is now
-- idempotent in the application (ensureTill) and opening a drawer never adds numbered tills. TL-1 is enforced in the
-- application (DRAWER_AREA_MISMATCH); existing open mismatched sessions are listed by scripts/drawers-mismatched.ts
-- for a manager to close properly — nothing is closed or moved here.
