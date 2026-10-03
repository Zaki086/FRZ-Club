-- v3 phase 6 (additive only): club cancellations (§7.2 CC-1…CC-8) and lead assignment (§8.2 LA-1…LA-8).
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'CANCELLED_BY_CLUB';
ALTER TYPE "ParticipantStatus" ADD VALUE IF NOT EXISTS 'CANCELLED_BY_CLUB';

CREATE SEQUENCE court_closure_code_seq;
CREATE TABLE "court_closures" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "court_ids" TEXT[] NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "court_closures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT court_closures_reason CHECK (reason IN ('MAINTENANCE', 'WET_COURT', 'WEATHER', 'EVENT', 'OTHER')),
    CONSTRAINT court_closures_range CHECK (end_at > start_at)
);
CREATE UNIQUE INDEX "court_closures_code_key" ON "court_closures"("code");
ALTER TABLE "court_reservations" ADD COLUMN "closure_id" TEXT;
ALTER TABLE "court_reservations" ADD CONSTRAINT court_reservations_closure_fkey FOREIGN KEY ("closure_id") REFERENCES "court_closures"("id");

-- One per paid booking cancelled by the club: the member (or desk) chooses reschedule or refund.
CREATE TABLE "club_cancellations" (
    "id" TEXT NOT NULL,
    "closure_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "amount_paid" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CHOICE',
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "new_booking_id" TEXT,
    "refund_request_id" TEXT,
    "resolved_by" TEXT,
    "resolved_via" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "club_cancellations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT club_cancellations_closure_fkey FOREIGN KEY ("closure_id") REFERENCES "court_closures"("id"),
    CONSTRAINT club_cancellations_booking_fkey FOREIGN KEY ("booking_id") REFERENCES "bookings"("id"),
    CONSTRAINT club_cancellations_bill_fkey FOREIGN KEY ("bill_id") REFERENCES "bills"("id"),
    CONSTRAINT club_cancellations_new_booking_fkey FOREIGN KEY ("new_booking_id") REFERENCES "bookings"("id"),
    CONSTRAINT club_cancellations_refund_fkey FOREIGN KEY ("refund_request_id") REFERENCES "refund_requests"("id"),
    CONSTRAINT club_cancellations_status CHECK (status IN ('PENDING_CHOICE', 'RESCHEDULED', 'REFUNDED')),
    CONSTRAINT club_cancellations_via CHECK (resolved_via IS NULL OR resolved_via IN ('MEMBER', 'STAFF', 'AUTO')),
    CONSTRAINT club_cancellations_amount CHECK (amount_paid > 0)
);
CREATE UNIQUE INDEX "club_cancellations_booking_key" ON "club_cancellations"("booking_id");
CREATE INDEX "club_cancellations_status_idx" ON "club_cancellations"("status", "deadline_at");

-- LA-6: why a lead went to whom; LA-2 tie-break; LA-8: escalated once.
ALTER TABLE "leads" ADD COLUMN "assignment_reason" TEXT;
ALTER TABLE "leads" ADD COLUMN "assigned_at" TIMESTAMPTZ(3);
ALTER TABLE "leads" ADD COLUMN "escalated_at" TIMESTAMPTZ(3);
UPDATE "leads" SET "assigned_at" = "created_at" WHERE "assigned_to" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "leads_assigned_idx" ON "leads"("assigned_to", "status");

CREATE TRIGGER court_closures_no_delete BEFORE DELETE ON court_closures FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER club_cancellations_no_delete BEFORE DELETE ON club_cancellations FOR EACH ROW EXECUTE FUNCTION forbid_delete();
