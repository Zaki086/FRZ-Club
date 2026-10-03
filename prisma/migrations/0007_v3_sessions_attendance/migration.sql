-- v3 phase 3 (additive only): sliding sessions, leave expiry, attendance corrections and flags.
ALTER TABLE "sessions" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STAFF';
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" TIMESTAMPTZ(3);
ALTER TABLE "sessions" ADD COLUMN "absolute_expires_at" TIMESTAMPTZ(3);
ALTER TABLE "sessions" ADD CONSTRAINT sessions_kind CHECK (kind IN ('MEMBER', 'STAFF', 'KIOSK'));

ALTER TYPE "LeaveStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TABLE "attendance" ADD COLUMN "original_clock_in" TIMESTAMPTZ(3);
ALTER TABLE "attendance" ADD COLUMN "original_clock_out" TIMESTAMPTZ(3);
ALTER TABLE "attendance" ADD COLUMN "corrected_by" TEXT;
ALTER TABLE "attendance" ADD COLUMN "corrected_at" TIMESTAMPTZ(3);
ALTER TABLE "attendance" ADD COLUMN "correction_reason" TEXT;
ALTER TABLE "attendance" ADD COLUMN "missing_flagged_at" TIMESTAMPTZ(3);
ALTER TABLE "attendance" ADD CONSTRAINT attendance_correction_reason CHECK (corrected_at IS NULL OR length(correction_reason) >= 3);
ALTER TABLE "attendance" ADD CONSTRAINT attendance_clock_order CHECK (clock_out IS NULL OR clock_out >= clock_in);
CREATE INDEX IF NOT EXISTS attendance_clock_in_idx ON attendance (clock_in);
CREATE INDEX IF NOT EXISTS shifts_employee_date_idx ON shifts (employee_id, date);
