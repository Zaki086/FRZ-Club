-- v3 phase 4 (additive only): the refund workflow (§5.2) and online payments attributed to a drawer session (§5.1).
CREATE SEQUENCE refund_request_code_seq;
CREATE TABLE "refund_requests" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "auto_approved" BOOLEAN NOT NULL DEFAULT false,
    "policy" TEXT,
    "requested_via" TEXT NOT NULL,
    "requested_by" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "retry_of_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT refund_requests_bill_fkey FOREIGN KEY ("bill_id") REFERENCES "bills"("id"),
    CONSTRAINT refund_requests_retry_fkey FOREIGN KEY ("retry_of_id") REFERENCES "refund_requests"("id"),
    CONSTRAINT refund_requests_amount CHECK (amount > 0),
    CONSTRAINT refund_requests_status CHECK (status IN ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED', 'FAILED', 'CANCELLED')),
    CONSTRAINT refund_requests_reason CHECK (reason IN ('POLICY_CANCELLATION', 'CLUB_CANCELLATION', 'PRODUCT_RETURN', 'SERVICE_ISSUE', 'DUPLICATE_CHARGE', 'GOODWILL', 'OTHER')),
    CONSTRAINT refund_requests_via CHECK (requested_via IN ('STAFF', 'MEMBER', 'SYSTEM')),
    CONSTRAINT refund_requests_decided CHECK (status IN ('REQUESTED', 'CANCELLED') OR auto_approved OR decided_by IS NOT NULL)
);
CREATE UNIQUE INDEX "refund_requests_code_key" ON "refund_requests"("code");
CREATE INDEX "refund_requests_status_idx" ON "refund_requests"("status", "created_at");
CREATE INDEX "refund_requests_bill_idx" ON "refund_requests"("bill_id");

ALTER TABLE "payments" ADD COLUMN "refund_request_id" TEXT;
ALTER TABLE "payments" ADD CONSTRAINT payments_refund_request_fkey FOREIGN KEY ("refund_request_id") REFERENCES "refund_requests"("id");
CREATE INDEX "payments_refund_request_idx" ON "payments"("refund_request_id");
CREATE INDEX IF NOT EXISTS "payments_drawer_session_idx" ON "payments"("drawer_session_id");

-- Refunds made before this workflow existed get one already-approved request each, so the queue and the
-- "every refund belongs to a request" check cover them.
INSERT INTO refund_requests (id, code, bill_id, amount, reason, note, status, auto_approved, policy, requested_via, requested_by, completed_at, created_at, updated_at)
SELECT 'rr_' || p.id, 'RF-' || lpad(nextval('refund_request_code_seq')::text, 6, '0'), p.bill_id, p.amount, 'OTHER', COALESCE(p.note, ''),
       CASE p.status::text WHEN 'SUCCEEDED' THEN 'COMPLETED' WHEN 'PENDING' THEN 'APPROVED' ELSE 'FAILED' END,
       true, 'BEFORE_WORKFLOW', 'SYSTEM', p.received_by, CASE WHEN p.status::text = 'SUCCEEDED' THEN p.occurred_at END, p.occurred_at, p.occurred_at
  FROM payments p WHERE p.type = 'REFUND' ORDER BY p.occurred_at;
UPDATE payments SET refund_request_id = 'rr_' || id WHERE type = 'REFUND';

CREATE TRIGGER refund_requests_no_delete BEFORE DELETE ON refund_requests FOR EACH ROW EXECUTE FUNCTION forbid_delete();
