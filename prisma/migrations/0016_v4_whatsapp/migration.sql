-- v4 §5 WhatsApp automation (additive only).

-- §5.1 opt-in: "Send me booking and refund updates on WhatsApp" is stored with a timestamp on the person it was given
-- for (desk sign-up → member, public trial → guest, enquiry → lead; portal toggle → member). A "STOP" reply records
-- the opt-out. Opted in = opt_in_at IS NOT NULL AND (opt_out_at IS NULL OR opt_in_at > opt_out_at).
ALTER TABLE "members" ADD COLUMN "whatsapp_opt_in_at" TIMESTAMPTZ(3);
ALTER TABLE "members" ADD COLUMN "whatsapp_opt_out_at" TIMESTAMPTZ(3);
ALTER TABLE "guests" ADD COLUMN "whatsapp_opt_in_at" TIMESTAMPTZ(3);
ALTER TABLE "guests" ADD COLUMN "whatsapp_opt_out_at" TIMESTAMPTZ(3);
ALTER TABLE "leads" ADD COLUMN "whatsapp_opt_in_at" TIMESTAMPTZ(3);
ALTER TABLE "leads" ADD COLUMN "whatsapp_opt_out_at" TIMESTAMPTZ(3);

-- §5.4 step 6: the delivery status timeline reported by Meta's webhook for a WhatsApp API message (by wamid =
-- provider_id). wa_status is the furthest state reached (sent → delivered → read, or failed); it never moves back.
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_status" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_sent_at" TIMESTAMPTZ(3);
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_read_at" TIMESTAMPTZ(3);
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_failed_at" TIMESTAMPTZ(3);
ALTER TABLE "notification_deliveries" ADD COLUMN "wa_error_code" INTEGER;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT notification_deliveries_wa_status
  CHECK ("wa_status" IS NULL OR "wa_status" IN ('sent', 'delivered', 'read', 'failed'));
-- (lookups by wamid use notification_deliveries_provider_idx from 0009)

-- §5.4 step 6: inbound WhatsApp messages, one row per Meta message id, so a webhook delivered twice acts once.
CREATE TABLE "whatsapp_inbound" (
  "id"          TEXT PRIMARY KEY,              -- Meta message id (wamid)
  "from_phone"  TEXT NOT NULL,                 -- 91XXXXXXXXXX
  "type"        TEXT NOT NULL,                 -- text, button, image, …
  "text"        TEXT,
  "handled_as"  TEXT NOT NULL CHECK ("handled_as" IN ('STOP', 'TASK', 'IGNORED')),
  "delivery_id" TEXT REFERENCES "notification_deliveries"("id"),
  "received_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT app_now()
);
CREATE INDEX "whatsapp_inbound_from_idx" ON "whatsapp_inbound" ("from_phone", "received_at");
