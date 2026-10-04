-- v6 §2 (SENDALL) "Send all automatically" + §1 URL-3 render at send time. Additive only; safe on the live club's data.
--
-- SA-0: automatic WhatsApp is sent ONLY through the official WhatsApp Cloud API (src/server/services/whatsapp/*).
-- Nothing in this schema (or the app) automates WhatsApp Web / WhatsApp Desktop, simulates clicks or uses unofficial
-- libraries — that breaks WhatsApp's terms and gets the club's number banned.

-- ───────────── SA-1/SA-2/SA-3/SA-7: the manual queue's new statuses ─────────────
-- SKIPPED_NOT_RELEVANT (the reason is in `error`), SKIPPED_DUPLICATE (an older copy of the same event + recipient +
-- record), EXPIRED (older than `manual_message_max_age_days`; still sendable one by one after a confirmation) and
-- SENT_AUTOMATICALLY (a "Send all" job sent it on another channel or through the API — linked by `task_id` below).
-- The constraint is replaced by a strict superset of the old one, so every existing row stays valid.
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS notification_deliveries_status;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT notification_deliveries_status CHECK (status IN (
  'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'LINK_OPENED', 'SKIPPED',
  'SKIPPED_NOT_RELEVANT', 'SKIPPED_DUPLICATE', 'EXPIRED', 'SENT_AUTOMATICALLY'));

-- ───────────── URL-3: what a message is made of, rendered when it is opened or sent ─────────────
-- `render_spec`: {"v":1,"kind":"EVENT","title","body","link","wa"?} (system events: the event's text with the public
-- origin replaced by the token {{app.url}}, the in-app path and the WhatsApp API template values) or
-- {"v":1,"kind":"TEMPLATE","templateId","version","context","recordId","key","values","overrides"?} (v5 message
-- templates: the template + version and the variables). The text and links are built from it at open/send time with
-- the APP_URL of that moment. Rows without it (made before v6) keep using their stored text.
-- `context_ids`: the records the message is about ({"billId"}, {"membershipId"}, {"refundId"}, …) for the SA-1
-- relevance check and SA-2 de-duplication.
ALTER TABLE "notification_deliveries" ADD COLUMN "render_spec" JSONB;
ALTER TABLE "notification_deliveries" ADD COLUMN "context_ids" JSONB;

-- ───────────── SA-5…SA-11: "Send all" jobs ─────────────
-- One row per confirmed "Send all". `filter_key` is the normalised queue filter it applies to: SA-8 allows one
-- running (QUEUED/RUNNING) job per filter — a second click returns the running job (unique partial index).
CREATE TABLE "bulk_send_jobs" (
    "id"                 TEXT NOT NULL PRIMARY KEY,
    "filter_key"         TEXT NOT NULL,
    "filter"             TEXT NOT NULL DEFAULT '',
    "use_other_channels" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp_api"       BOOLEAN NOT NULL DEFAULT false,
    "announcements"      BOOLEAN NOT NULL DEFAULT false,
    "status"             TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED', 'RUNNING', 'DONE')),
    "total"              INTEGER NOT NULL DEFAULT 0 CHECK ("total" >= 0),
    "preflight"          JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_by"         TEXT REFERENCES "users"("id"),
    "started_at"         TIMESTAMPTZ(3),
    "finished_at"        TIMESTAMPTZ(3),
    "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT app_now()
);
CREATE UNIQUE INDEX "bulk_send_jobs_one_running" ON "bulk_send_jobs" ("filter_key") WHERE "status" IN ('QUEUED', 'RUNNING');
CREATE INDEX "bulk_send_jobs_created_idx" ON "bulk_send_jobs" ("created_at");
CREATE TRIGGER bulk_send_jobs_no_delete BEFORE DELETE ON bulk_send_jobs FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- One row per manual task the job sends: the channels chosen at confirm (WHATSAPP_API, or EMAIL and/or PUSH instead),
-- its progress and the reason when it could not be sent (the task then stays in the queue with that reason).
CREATE TABLE "bulk_send_job_items" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "job_id"     TEXT NOT NULL REFERENCES "bulk_send_jobs"("id"),
    "task_id"    TEXT NOT NULL REFERENCES "notification_deliveries"("id"),
    "channels"   TEXT[] NOT NULL CHECK ("channels" <@ ARRAY['WHATSAPP_API', 'EMAIL', 'PUSH']::text[] AND cardinality("channels") > 0),
    "status"     TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'SENDING', 'WAITING', 'SENT', 'FAILED', 'SKIPPED')),
    "error"      TEXT,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMPTZ(3),
    "sent_at"    TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    CONSTRAINT "bulk_send_job_items_once" UNIQUE ("job_id", "task_id")
);
CREATE INDEX "bulk_send_job_items_job_status_idx" ON "bulk_send_job_items" ("job_id", "status");
CREATE TRIGGER bulk_send_job_items_no_delete BEFORE DELETE ON bulk_send_job_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- The delivery rows a job wrote for a task (SA-7 "linked to their delivery rows"): `task_id` = the manual task,
-- `bulk_job_id` = the job.
ALTER TABLE "notification_deliveries" ADD COLUMN "bulk_job_id" TEXT REFERENCES "bulk_send_jobs"("id");
ALTER TABLE "notification_deliveries" ADD COLUMN "task_id" TEXT REFERENCES "notification_deliveries"("id");
CREATE INDEX "notification_deliveries_task_idx" ON "notification_deliveries" ("task_id") WHERE "task_id" IS NOT NULL;
CREATE INDEX "notification_deliveries_bulk_job_idx" ON "notification_deliveries" ("bulk_job_id", "channel", "status") WHERE "bulk_job_id" IS NOT NULL;
-- The manual queue (Messages to Send, Send all): manual rows by status and age.
CREATE INDEX "notification_deliveries_manual_idx" ON "notification_deliveries" ("status", "created_at") WHERE "channel" = 'WHATSAPP_MANUAL';

-- SA-11: every message a job sends is in the Message Log with the job id (channel, status and error were there).
ALTER TABLE "message_log" ADD COLUMN "job_id" TEXT;
CREATE INDEX "message_log_job_idx" ON "message_log" ("job_id") WHERE "job_id" IS NOT NULL;
