-- v4 §3 Refunds v2 (additive only): cash refunds are collected at the desk and never forgotten.
-- RF-8  READY_TO_COLLECT is a sub-status of APPROVED (the v3 state machine is unchanged): `collect_status` says where
--       the money waiting at the desk stands, `ready_at` when it became collectable (reminders count from it).
-- RF-9  Who checked the collector's identity at pay-out, when and how (refund QR, member card, search, guest phone +
--       original code).
-- RF-10 Unclaimed reminders (3 and 7 days, then every 14 days, max 4): how many have gone out and when the last one did.
ALTER TABLE "refund_requests" ADD COLUMN "collect_status" TEXT;
ALTER TABLE "refund_requests" ADD COLUMN "ready_at" TIMESTAMPTZ(3);
ALTER TABLE "refund_requests" ADD COLUMN "identity_checked_by" TEXT;
ALTER TABLE "refund_requests" ADD COLUMN "identity_checked_at" TIMESTAMPTZ(3);
ALTER TABLE "refund_requests" ADD COLUMN "identity_method" TEXT;
ALTER TABLE "refund_requests" ADD COLUMN "reminders_sent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "refund_requests" ADD COLUMN "last_reminder_at" TIMESTAMPTZ(3);

-- Approved requests whose money is already waiting at the desk are ready to collect since they were decided.
UPDATE "refund_requests" r SET "collect_status" = 'READY_TO_COLLECT', "ready_at" = COALESCE(r."decided_at", r."created_at")
 WHERE r."status" = 'APPROVED'
   AND EXISTS (SELECT 1 FROM "payments" p WHERE p."refund_request_id" = r."id" AND p."type" = 'REFUND' AND p."status" = 'PENDING');

ALTER TABLE "refund_requests" ADD CONSTRAINT refund_requests_collect_status CHECK ("collect_status" IS NULL OR "collect_status" IN ('READY_TO_COLLECT', 'COLLECTED'));
ALTER TABLE "refund_requests" ADD CONSTRAINT refund_requests_ready_is_approved CHECK ("collect_status" IS DISTINCT FROM 'READY_TO_COLLECT' OR ("status" = 'APPROVED' AND "ready_at" IS NOT NULL));
ALTER TABLE "refund_requests" ADD CONSTRAINT refund_requests_collected_is_completed CHECK ("collect_status" IS DISTINCT FROM 'COLLECTED' OR "status" = 'COMPLETED');
ALTER TABLE "refund_requests" ADD CONSTRAINT refund_requests_identity_method CHECK ("identity_method" IS NULL OR "identity_method" IN ('REFUND_QR', 'MEMBER_CARD', 'SEARCH', 'GUEST_PHONE_CODE'));
ALTER TABLE "refund_requests" ADD CONSTRAINT refund_requests_identity_complete CHECK (("identity_checked_by" IS NULL) = ("identity_checked_at" IS NULL));
ALTER TABLE "refund_requests" ADD CONSTRAINT refund_requests_reminders CHECK ("reminders_sent" BETWEEN 0 AND 4);
ALTER TABLE "refund_requests" ADD CONSTRAINT refund_requests_identity_by_fkey FOREIGN KEY ("identity_checked_by") REFERENCES "users"("id");

CREATE INDEX "refund_requests_ready_idx" ON "refund_requests"("ready_at") WHERE "collect_status" = 'READY_TO_COLLECT';
