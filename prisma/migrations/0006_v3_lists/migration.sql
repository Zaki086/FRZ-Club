-- v3 phase 2 (additive only): saved list views and indexes for server-side filtering.
CREATE TABLE "saved_views" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id"),
    CONSTRAINT saved_views_user_fk FOREIGN KEY ("user_id") REFERENCES "users"("id"),
    CONSTRAINT saved_views_name CHECK (length(name) BETWEEN 1 AND 60 AND length(query) <= 2000)
);
CREATE UNIQUE INDEX "saved_views_user_id_list_name_key" ON "saved_views"("user_id", "list", "name");

CREATE INDEX IF NOT EXISTS leads_status_follow_up_idx ON leads (status, next_follow_up_at);
CREATE INDEX IF NOT EXISTS leads_assigned_to_idx ON leads (assigned_to);
CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
CREATE INDEX IF NOT EXISTS court_reservations_start_at_idx ON court_reservations (start_at);
CREATE INDEX IF NOT EXISTS memberships_member_status_idx ON memberships (member_id, status);
CREATE INDEX IF NOT EXISTS visits_member_checked_in_idx ON visits (member_id, checked_in_at);
CREATE INDEX IF NOT EXISTS tabs_member_status_idx ON tabs (member_id, status);
CREATE INDEX IF NOT EXISTS booking_players_member_idx ON booking_players (member_id);
CREATE INDEX IF NOT EXISTS members_created_at_idx ON members (created_at);
