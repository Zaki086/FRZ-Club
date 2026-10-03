-- Completion pass phase 3 (additive only): expense bill attachments.
ALTER TABLE "expense_bills" ADD COLUMN "attachment_url" TEXT;
ALTER TABLE "expense_bills" ADD CONSTRAINT expense_bills_attachment_url CHECK (attachment_url IS NULL OR attachment_url LIKE '/api/uploads/expense/%');
