-- v3 phase 5 (additive only): notification channels (§6.3), walk-in credentials (§6.4), dues reminders (§6.5).
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "member_id" TEXT,
    "to_address" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "whatsapp_text" TEXT,
    "provider_id" TEXT,
    "error" TEXT,
    "triggered_by" TEXT,
    "handled_by" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "opened_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT notification_deliveries_user_fkey FOREIGN KEY ("user_id") REFERENCES "users"("id"),
    CONSTRAINT notification_deliveries_channel CHECK (channel IN ('IN_APP', 'PUSH', 'EMAIL', 'WHATSAPP_API', 'WHATSAPP_MANUAL')),
    CONSTRAINT notification_deliveries_status CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'LINK_OPENED', 'SKIPPED'))
);
-- NT-1: exactly once per event key + channel.
CREATE UNIQUE INDEX "notification_deliveries_once" ON "notification_deliveries"("dedupe_key", "channel");
CREATE INDEX "notification_deliveries_queue_idx" ON "notification_deliveries"("channel", "status");
CREATE INDEX "notification_deliveries_user_idx" ON "notification_deliveries"("user_id", "created_at");
CREATE INDEX "notification_deliveries_member_idx" ON "notification_deliveries"("member_id");
CREATE INDEX "notification_deliveries_created_idx" ON "notification_deliveries"("created_at");
CREATE INDEX "notification_deliveries_provider_idx" ON "notification_deliveries"("provider_id");

CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "last_success_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT push_subscriptions_user_fkey FOREIGN KEY ("user_id") REFERENCES "users"("id")
);
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions"("user_id");

-- Member preferences (in-app can't be turned off) and when credentials were first issued (WK-2).
ALTER TABLE "users" ADD COLUMN "notify_push" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "notify_email" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "notify_whatsapp" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "credentials_issued_at" TIMESTAMPTZ(3);
-- Members who could already log in keep their login unchanged (WK-7).
UPDATE "users" SET "credentials_issued_at" = COALESCE("password_changed_at", "created_at") WHERE "role" = 'MEMBER' AND "password_hash" IS NOT NULL;

-- NT-2: at most three dues reminders per bill, a week apart.
CREATE TABLE "dues_reminders" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "dues_reminders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT dues_reminders_bill_fkey FOREIGN KEY ("bill_id") REFERENCES "bills"("id"),
    CONSTRAINT dues_reminders_seq CHECK (seq BETWEEN 1 AND 3)
);
CREATE UNIQUE INDEX "dues_reminders_once" ON "dues_reminders"("bill_id", "seq");

CREATE TRIGGER notification_deliveries_no_delete BEFORE DELETE ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION forbid_delete();
