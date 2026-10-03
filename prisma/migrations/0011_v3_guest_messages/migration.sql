-- v3 CC-3 (additive only): a walk-in guest with a phone can get a manual WhatsApp task, so a delivery may name a
-- guest instead of a user (exactly one of the two).
ALTER TABLE "notification_deliveries" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "notification_deliveries" ADD COLUMN "guest_id" TEXT;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT notification_deliveries_guest_fkey FOREIGN KEY ("guest_id") REFERENCES "guests"("id");
ALTER TABLE "notification_deliveries" ADD CONSTRAINT notification_deliveries_recipient CHECK ((user_id IS NULL) <> (guest_id IS NULL));
