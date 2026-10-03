-- v4 §4.2 + §5.4 (PUSH): delivery queue mechanics, additive only.

-- Every queued delivery counts its tries and may carry the earliest time it can go out: the end of the push quiet
-- hours (22:00–07:00 IST) for a non-urgent push, or the next retry after a failure. `urgent` = sent during quiet
-- hours (same-day club cancellation, session reminders). A WhatsApp Cloud API row carries the approved template, its
-- language, the body parameters (JSON array of strings, already sanitised) and the URL button parameter; the plain
-- text in `whatsapp_text` is what the manual fallback task sends when the API can't.
ALTER TABLE "notification_deliveries" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "notification_deliveries" ADD COLUMN "not_before" TIMESTAMPTZ(3);
ALTER TABLE "notification_deliveries" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_template" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_language" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_params" JSONB;
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_button_param" TEXT;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT notification_deliveries_attempts CHECK ("attempts" >= 0);
ALTER TABLE "notification_deliveries" ADD CONSTRAINT notification_deliveries_wa_params
  CHECK ("wa_params" IS NULL OR jsonb_typeof("wa_params") = 'array');

-- The worker's sweep: queued rows per channel that are due.
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" ("channel", "not_before", "created_at") WHERE "status" = 'QUEUED';

-- §5.4 step 9: a rate-limit answer pauses all sending on a channel until `paused_until` (rows stay QUEUED).
CREATE TABLE "delivery_pauses" (
  "channel"      TEXT PRIMARY KEY CHECK ("channel" IN ('PUSH', 'EMAIL', 'WHATSAPP_API')),
  "paused_until" TIMESTAMPTZ(3) NOT NULL,
  "reason"       TEXT NOT NULL,
  "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT app_now()
);
