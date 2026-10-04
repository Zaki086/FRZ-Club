-- v5 §3 (MSGCORE) ready-made manual messages: template library with versions, announcement unsubscribe, the template
-- columns of the Message Log and the bulk send queue. Additive only; safe on the live club's data.

-- ───────────── §3.1 template library (MT-1…MT-3) ─────────────
-- The current text lives on the template; every save (create or edit) also writes an immutable version row, and every
-- send records the template id + version (MT-3). Templates are archived, never deleted. `key` names the 18 ready-made
-- templates (NULL for the Owner's own); `wa_template` is the v4 §5 Meta template used for "Send automatically on
-- WhatsApp" (only when the WhatsApp API is on and that template is mapped and APPROVED).
CREATE TABLE "message_templates" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "key"           TEXT UNIQUE,
    "name"          TEXT NOT NULL,
    "context"       TEXT NOT NULL CHECK ("context" IN ('MEMBER', 'BOOKING', 'REFUND', 'ORDER', 'TAB', 'LEAD', 'INVOICE', 'GENERAL')),
    "category"      TEXT NOT NULL CHECK ("category" IN ('TRANSACTIONAL', 'ANNOUNCEMENT')),
    "channels"      TEXT[] NOT NULL DEFAULT '{}' CHECK ("channels" <@ ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[]),
    "whatsapp_text" TEXT NOT NULL DEFAULT '',
    "email_subject" TEXT NOT NULL DEFAULT '',
    "email_body"    TEXT NOT NULL DEFAULT '',
    "push_title"    TEXT NOT NULL DEFAULT '',
    "push_body"     TEXT NOT NULL DEFAULT '',
    "wa_template"   TEXT,
    "active"        BOOLEAN NOT NULL DEFAULT true,
    "archived_at"   TIMESTAMPTZ(3),
    "version"       INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
    "sort_order"    INTEGER NOT NULL DEFAULT 0,
    "created_by"    TEXT,
    "updated_by"    TEXT,
    "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT app_now()
);
-- One live template per name (archived ones may share it).
CREATE UNIQUE INDEX "message_templates_name_live" ON "message_templates" (lower("name")) WHERE "archived_at" IS NULL;
CREATE INDEX "message_templates_context_idx" ON "message_templates" ("context", "sort_order");
CREATE TRIGGER message_templates_no_delete BEFORE DELETE ON message_templates FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE "message_template_versions" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "template_id"   TEXT NOT NULL REFERENCES "message_templates"("id"),
    "version"       INTEGER NOT NULL CHECK ("version" >= 1),
    "name"          TEXT NOT NULL,
    "context"       TEXT NOT NULL,
    "category"      TEXT NOT NULL,
    "channels"      TEXT[] NOT NULL,
    "whatsapp_text" TEXT NOT NULL,
    "email_subject" TEXT NOT NULL,
    "email_body"    TEXT NOT NULL,
    "push_title"    TEXT NOT NULL,
    "push_body"     TEXT NOT NULL,
    "wa_template"   TEXT,
    "created_by"    TEXT,
    "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    CONSTRAINT "message_template_versions_once" UNIQUE ("template_id", "version")
);
-- MT-3: a version is what was sent; it never changes and is never deleted.
CREATE TRIGGER message_template_versions_append_only BEFORE UPDATE OR DELETE ON message_template_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────── §3.2 one-click unsubscribe from announcement emails ─────────────
-- Set by the signed link in an ANNOUNCEMENT email (TRANSACTIONAL emails have no link and ignore it).
ALTER TABLE "members" ADD COLUMN "email_announcements_opt_out" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "members" ADD COLUMN "email_announcements_opt_out_at" TIMESTAMPTZ(3);
ALTER TABLE "leads" ADD COLUMN "email_announcements_opt_out" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN "email_announcements_opt_out_at" TIMESTAMPTZ(3);

-- ───────────── §3.4 bulk sends ─────────────
-- One row per bulk send from a list. Its messages are notification_deliveries rows with this bulk_id: email, push and
-- automatic WhatsApp are sent by the worker at ≤ 1 message per second; manual WhatsApp rows are the per-recipient
-- tasks in "Messages to send". `skipped` lists who was left out and why (opted out, no address, …).
CREATE TABLE "message_bulk_sends" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "template_id"      TEXT NOT NULL REFERENCES "message_templates"("id"),
    "template_version" INTEGER NOT NULL,
    "list"             TEXT NOT NULL CHECK ("list" IN ('members', 'renewals', 'checkin-risk', 'leads')),
    "filter"           TEXT,
    "selected"         INTEGER NOT NULL DEFAULT 0,
    "channels"         TEXT[] NOT NULL,
    "auto_whatsapp"    BOOLEAN NOT NULL DEFAULT false,
    "overrides"        JSONB,
    "status"           TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED', 'SENDING', 'DONE')),
    "total"            INTEGER NOT NULL DEFAULT 0,
    "skipped"          JSONB NOT NULL DEFAULT '[]'::jsonb,
    "created_by"       TEXT,
    "started_at"       TIMESTAMPTZ(3),
    "finished_at"      TIMESTAMPTZ(3),
    "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT app_now()
);
CREATE INDEX "message_bulk_sends_created_idx" ON "message_bulk_sends" ("created_at");
CREATE TRIGGER message_bulk_sends_no_delete BEFORE DELETE ON message_bulk_sends FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- The worker's rate gate: at most one bulk message per second across every worker process (a conditional UPDATE of
-- this row is the permit to send).
CREATE TABLE "message_rate_gate" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "last_sent_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT app_now()
);
INSERT INTO "message_rate_gate" ("id", "last_sent_at") VALUES ('bulk', 'epoch') ON CONFLICT DO NOTHING;

-- ───────────── §3.3 MT-6: every template send in the Message Log ─────────────
-- Template + version, the template's context/category, the record it was about, the recipient (masked copy for display;
-- `to_address` stays the real address the message goes to), the bulk send, the push device. `triggered_by` is who sent
-- it. Rows waiting for the messages worker carry handled_by = 'msgq:queue' (the push/email worker leaves them alone).
ALTER TABLE "notification_deliveries" ADD COLUMN "template_id" TEXT REFERENCES "message_templates"("id");
ALTER TABLE "notification_deliveries" ADD COLUMN "template_version" INTEGER;
ALTER TABLE "notification_deliveries" ADD COLUMN "template_context" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "template_category" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "record_id" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "recipient_key" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "lead_id" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "to_masked" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "send_id" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "bulk_id" TEXT REFERENCES "message_bulk_sends"("id");
ALTER TABLE "notification_deliveries" ADD COLUMN "push_subscription_id" TEXT;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT notification_deliveries_template_version
  CHECK (("template_id" IS NULL) = ("template_version" IS NULL));
-- Duplicate guard (same template + recipient within 24 h) and the bulk progress counts.
CREATE INDEX "notification_deliveries_template_recipient_idx" ON "notification_deliveries" ("template_id", "recipient_key", "created_at") WHERE "template_id" IS NOT NULL;
CREATE INDEX "notification_deliveries_bulk_idx" ON "notification_deliveries" ("bulk_id", "channel", "status") WHERE "bulk_id" IS NOT NULL;
CREATE INDEX "notification_deliveries_msgq_idx" ON "notification_deliveries" ("created_at", "id") WHERE "status" = 'QUEUED' AND "handled_by" = 'msgq:queue';

-- ───────────── the 18 ready-made templates (active, version 1) ─────────────
-- Idempotent: inserted once by key (an Owner's later edits are never overwritten). The same rows come from
-- src/server/services/messages/ready-made.ts (ensureReadyMadeTemplates after a database reset).
-- >>> ready-made templates
INSERT INTO "message_templates" ("id", "key", "name", "context", "category", "channels", "whatsapp_text", "email_subject", "email_body", "push_title", "push_body", "wa_template", "sort_order")
VALUES
  ($mt$mt_membership_expiring$mt$, $mt$membership_expiring$mt$, $mt$Membership expiring soon$mt$, 'MEMBER', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, your *{{membership.plan}}* membership at {{club.name}} ends on *{{membership.end_date}}*.

Renew before then to keep your member court rates and advance booking. Renew in the member portal: {{link}}
Or renew at the front desk on your next visit.

Questions? Call {{club.phone}}.$mt$,
   $mt$Your {{club.name}} membership ends on {{membership.end_date}}$mt$,
   $mt$Hi {{member.first_name}},

Your {{membership.plan}} membership (member code {{member.code}}) ends on {{membership.end_date}}.

Renew before then to keep your member court rates and advance booking without a break. You can renew in the member portal in a minute, or at the front desk on your next visit.

Questions? Call us on {{club.phone}}.

See you on court,
{{club.name}}$mt$,
   $mt$Membership ends {{membership.end_date}}$mt$, $mt$Renew your {{membership.plan}} membership to keep your member rates. Tap to renew.$mt$, 'membership_expiring', 10),
  ($mt$mt_membership_expired$mt$, $mt$membership_expired$mt$, $mt$Membership expired — renew$mt$, 'MEMBER', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, your *{{membership.plan}}* membership at {{club.name}} ended on *{{membership.end_date}}*.

Until you renew, courts and social play are charged at walk-in rates. Renew in a minute in the member portal: {{link}}
Or renew at the front desk on your next visit.

We'd love to have you back. Questions? Call {{club.phone}}.$mt$,
   $mt$Your {{club.name}} membership has ended — renew to keep member rates$mt$,
   $mt$Hi {{member.first_name}},

Your {{membership.plan}} membership (member code {{member.code}}) ended on {{membership.end_date}}.

Until you renew, court bookings and social play are charged at walk-in rates. Renewing takes a minute in the member portal, or at the front desk on your next visit — your member code stays the same.

Questions? Call us on {{club.phone}}.

We'd love to see you back on court,
{{club.name}}$mt$,
   $mt$Your membership has ended$mt$, $mt$Your {{membership.plan}} membership ended on {{membership.end_date}}. Tap to renew.$mt$, NULL, 20),
  ($mt$mt_dues_reminder$mt$, $mt$dues_reminder$mt$, $mt$Dues reminder$mt$, 'MEMBER', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, a friendly reminder from {{club.name}}: *{{dues.amount}}* is due on your account (member code *{{member.code}}*).

Please pay at the front desk on your next visit. See what it's for: {{link}}

Already paid? Thank you, please ignore this message. Questions: {{club.phone}}$mt$,
   $mt$Amount due at {{club.name}}: {{dues.amount}}$mt$,
   $mt$Hi {{member.first_name}},

A friendly reminder: {{dues.amount}} is due on your account (member code {{member.code}}).

You can see each unpaid bill in the member portal, and pay at the front desk on your next visit.

Already paid? Thank you — please ignore this email. Questions? Call us on {{club.phone}}.

Thank you,
{{club.name}}$mt$,
   $mt${{dues.amount}} due$mt$, $mt$You have {{dues.amount}} due at {{club.name}}. Pay at the front desk — tap for details.$mt$, 'dues_reminder', 30),
  ($mt$mt_welcome_portal$mt$, $mt$welcome_portal$mt$, $mt$Welcome + portal login$mt$, 'MEMBER', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Welcome to {{club.name}}, {{member.first_name}}!

Your member code is *{{member.code}}* and your plan is *{{membership.plan}}*, valid until *{{membership.end_date}}*.

Book courts, join social play and see your bills in the member portal: {{portal.url}}
Log in with your mobile number. First time? Use "Forgot password" on the login page to set one.

See you at the club!$mt$,
   $mt$Welcome to {{club.name}} — your member code is {{member.code}}$mt$,
   $mt$Hi {{member.first_name}},

Welcome to {{club.name}}! We're glad to have you.

Your member code: {{member.code}}
Your plan: {{membership.plan}}, valid until {{membership.end_date}}

In the member portal you can book courts, join social play, see your bills and manage your membership: {{portal.url}}

Log in with your mobile number. First time? Use "Forgot password" on the login page to set your password.

See you at the club,
{{club.name}}$mt$,
   $mt$Welcome to {{club.name}}$mt$, $mt$Your member code is {{member.code}}. Book your first court in the portal.$mt$, 'membership_welcome', 40),
  ($mt$mt_booking_reminder$mt$, $mt$booking_reminder$mt$, $mt$Booking reminder$mt$, 'BOOKING', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, a reminder of your booking at {{club.name}}:

*{{booking.court}}*
*{{booking.date}}, {{booking.time}}*
Booking *{{booking.code}}*

Please check in at the front desk when you arrive. Need to change it? {{link}}
Or call us on {{club.phone}}.$mt$,
   $mt$Reminder: {{booking.court}} on {{booking.date}}, {{booking.time}}$mt$,
   $mt$Hi {{member.first_name}},

A reminder of your court booking at {{club.name}}:

Court: {{booking.court}}
When: {{booking.date}}, {{booking.time}}
Booking: {{booking.code}}

Please check in at the front desk when you arrive. Need to change or cancel? You can do it in the member portal, or call us on {{club.phone}}.

See you on court,
{{club.name}}$mt$,
   $mt${{booking.court}} · {{booking.time}}$mt$, $mt$Your booking {{booking.code}} on {{booking.date}}. Check in at the front desk when you arrive.$mt$, NULL, 50),
  ($mt$mt_booking_cancelled$mt$, $mt$booking_cancelled$mt$, $mt$Booking cancelled$mt$, 'BOOKING', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, your booking *{{booking.code}}* at {{club.name}} is *cancelled*:
{{booking.court}}, {{booking.date}}, {{booking.time}}

If you had paid, any refund due is shown in the member portal: {{link}}

Want to play another time? Book a new slot in the portal or call {{club.phone}}.$mt$,
   $mt$Booking {{booking.code}} cancelled$mt$,
   $mt$Hi {{member.first_name}},

Your booking {{booking.code}} at {{club.name}} has been cancelled:

Court: {{booking.court}}
When: {{booking.date}}, {{booking.time}}

If you had paid for it, any refund due is shown in the member portal.

Want to play another time? Book a new slot in the portal, or call us on {{club.phone}}.

{{club.name}}$mt$,
   $mt$Booking {{booking.code}} cancelled$mt$, $mt${{booking.court}}, {{booking.date}} {{booking.time}} is cancelled. Tap for details.$mt$, NULL, 60),
  ($mt$mt_session_cancelled_by_club$mt$, $mt$session_cancelled_by_club$mt$, $mt$Session cancelled by club (choose reschedule/refund)$mt$, 'BOOKING', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, we're sorry — {{club.name}} had to cancel your session:
*{{booking.court}}, {{booking.date}}, {{booking.time}}* (booking *{{booking.code}}*).

Please choose what you'd like: *move it to another time* or *get a refund*. Choose here: {{link}}

Prefer to talk? Call {{club.phone}} and we'll sort it out for you.$mt$,
   $mt$We had to cancel your session on {{booking.date}} — reschedule or refund?$mt$,
   $mt$Hi {{member.first_name}},

We're sorry — we had to cancel your session at {{club.name}}:

Court: {{booking.court}}
When: {{booking.date}}, {{booking.time}}
Booking: {{booking.code}}

Please choose what you'd like: move it to another time at no extra cost, or get a refund. Choose with the button below.

Prefer to talk? Call us on {{club.phone}} and we'll sort it out for you.

With apologies,
{{club.name}}$mt$,
   $mt$Session cancelled by the club$mt$, $mt${{booking.court}}, {{booking.date}} {{booking.time}}. Choose: reschedule or refund.$mt$, NULL, 70),
  ($mt$mt_reschedule_confirmed$mt$, $mt$reschedule_confirmed$mt$, $mt$Reschedule confirmed$mt$, 'BOOKING', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, your session at {{club.name}} is *moved*. Your new booking:

*{{booking.court}}*
*{{booking.date}}, {{booking.time}}*
Booking *{{booking.code}}*

It's in your bookings in the member portal: {{link}}
See you on court!$mt$,
   $mt$Rescheduled: {{booking.court}} on {{booking.date}}, {{booking.time}}$mt$,
   $mt$Hi {{member.first_name}},

Your session at {{club.name}} has been moved. Your new booking:

Court: {{booking.court}}
When: {{booking.date}}, {{booking.time}}
Booking: {{booking.code}}

Please check in at the front desk when you arrive. Questions? Call us on {{club.phone}}.

See you on court,
{{club.name}}$mt$,
   $mt$Rescheduled: {{booking.date}}$mt$, $mt${{booking.court}}, {{booking.time}} · booking {{booking.code}}.$mt$, 'booking_rescheduled', 80),
  ($mt$mt_refund_ready$mt$, $mt$refund_ready$mt$, $mt$Refund ready to collect$mt$, 'REFUND', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, your refund of *{{refund.amount}}* from {{club.name}} is *ready to collect* in cash at the front desk.
Refund ref: *{{refund.code}}*

Show this collection QR at the desk: {{link}}
Please bring a photo ID. Questions: {{club.phone}}$mt$,
   $mt$Your refund of {{refund.amount}} is ready to collect$mt$,
   $mt$Hi {{member.first_name}},

Your refund of {{refund.amount}} (ref {{refund.code}}) is ready to collect in cash at the {{club.name}} front desk.

Show the collection QR at the desk — open it with the button below — and please bring a photo ID.

Questions? Call us on {{club.phone}}.

{{club.name}}$mt$,
   $mt$Refund ready: {{refund.amount}}$mt$, $mt$Collect it in cash at the front desk (ref {{refund.code}}). Tap to show your QR.$mt$, 'refund_ready_to_collect', 90),
  ($mt$mt_refund_collected$mt$, $mt$refund_collected$mt$, $mt$Refund collected — receipt$mt$, 'REFUND', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, this confirms you collected your refund of *{{refund.amount}}* (ref *{{refund.code}}*) at {{club.name}}.

Your receipt: {{link}}

Thank you!$mt$,
   $mt$Refund receipt {{refund.code}}: {{refund.amount}} collected$mt$,
   $mt$Hi {{member.first_name}},

This confirms you collected your refund of {{refund.amount}} (ref {{refund.code}}) at the {{club.name}} front desk.

Your receipt is in the member portal. Questions? Call us on {{club.phone}}.

Thank you,
{{club.name}}$mt$,
   $mt$Refund collected: {{refund.amount}}$mt$, $mt$Ref {{refund.code}} — your receipt is in the member portal.$mt$, 'refund_completed', 100),
  ($mt$mt_order_ready$mt$, $mt$order_ready$mt$, $mt$Order ready for pickup$mt$, 'ORDER', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, good news — your order *{{order.code}}* is *ready for pickup* at the {{club.name}} shop.

Collect it at the front desk. Order details and anything to pay: {{link}}

Questions: {{club.phone}}$mt$,
   $mt$Your order {{order.code}} is ready for pickup$mt$,
   $mt$Hi {{member.first_name}},

Good news — your order {{order.code}} is ready for pickup at the {{club.name}} shop.

Collect it at the front desk on your next visit. The button below shows the order and anything still to pay.

Questions? Call us on {{club.phone}}.

{{club.name}}$mt$,
   $mt$Order {{order.code}} is ready$mt$, $mt$Collect it at the club shop (front desk).$mt$, NULL, 110),
  ($mt$mt_restring_ready$mt$, $mt$restring_ready$mt$, $mt$Restring ready$mt$, 'ORDER', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, your racket is *restrung and ready* (ticket *{{order.code}}*).

Collect it from the {{club.name}} shop at the front desk. Questions: {{club.phone}}

Enjoy the fresh strings!$mt$,
   $mt$Your racket is ready — ticket {{order.code}}$mt$,
   $mt$Hi {{member.first_name}},

Your racket is restrung and ready to collect (ticket {{order.code}}).

Pick it up from the {{club.name}} shop at the front desk. Questions? Call us on {{club.phone}}.

Enjoy the fresh strings,
{{club.name}}$mt$,
   $mt$Your racket is ready$mt$, $mt$Restring {{order.code}} — collect it at the club shop.$mt$, NULL, 120),
  ($mt$mt_settle_tab$mt$, $mt$settle_tab$mt$, $mt$Please settle your bar tab$mt$, 'TAB', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, your bar tab at {{club.name}} is *{{tab.total}}*.

Please settle it at the bar — before you leave today or on your next visit.
See your tab: {{link}}

Thank you!$mt$,
   $mt$Your bar tab at {{club.name}}: {{tab.total}}$mt$,
   $mt$Hi {{member.first_name}},

Your bar tab at {{club.name}} is {{tab.total}}.

Please settle it at the bar — before you leave today or on your next visit. You can see every item on your tab in the member portal.

Thank you,
{{club.name}}$mt$,
   $mt$Bar tab: {{tab.total}}$mt$, $mt$Please settle your tab at the bar. Tap to see it.$mt$, NULL, 130),
  ($mt$mt_trial_follow_up$mt$, $mt$trial_follow_up$mt$, $mt$Trial follow-up$mt$, 'LEAD', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL']::text[],
   $mt$Hi {{lead.first_name}}, thank you for trying {{club.name}}! We hope you enjoyed your session.

As a member you get member court rates, booking further ahead and social play with other members. See the plans: {{link}}

Reply here or call *{{club.phone}}* and we'll help you choose the right plan.$mt$,
   $mt$Thanks for trying {{club.name}} — ready to join?$mt$,
   $mt$Hi {{lead.first_name}},

Thank you for trying {{club.name}} — we hope you enjoyed your session!

As a member you get member court rates, can book further ahead and join social play with other members. The plans and prices are a click away.

Reply to this email or call us on {{club.phone}} and we'll help you choose the right plan.

Hope to see you again soon,
{{club.name}}$mt$,
   $mt$$mt$, $mt$$mt$, NULL, 140),
  ($mt$mt_quote_follow_up$mt$, $mt$quote_follow_up$mt$, $mt$Quote follow-up$mt$, 'LEAD', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL']::text[],
   $mt$Hi {{lead.first_name}}, following up on your membership quote from {{club.name}}. You can see it here: {{link}}

Any questions about the plans or prices? Reply here or call *{{club.phone}}* — happy to help.$mt$,
   $mt$Your quote from {{club.name}}$mt$,
   $mt$Hi {{lead.first_name}},

Following up on the membership quote we sent you. You can open it with the button below.

Any questions about the plans or prices? Reply to this email or call us on {{club.phone}} — we're happy to help.

{{club.name}}$mt$,
   $mt$$mt$, $mt$$mt$, NULL, 150),
  ($mt$mt_invoice_due$mt$, $mt$invoice_due$mt$, $mt$Invoice due reminder$mt$, 'INVOICE', 'TRANSACTIONAL', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hi {{member.first_name}}, a reminder that invoice *{{invoice.number}}* from {{club.name}} is due on *{{invoice.due_date}}*.

View the invoice: {{link}}

Already paid? Thank you, please ignore this message. Questions: {{club.phone}}$mt$,
   $mt$Invoice {{invoice.number}} is due on {{invoice.due_date}}$mt$,
   $mt$Hi {{member.first_name}},

A reminder that invoice {{invoice.number}} from {{club.name}} is due on {{invoice.due_date}}.

Already paid? Thank you — please ignore this email. Questions about the invoice? Call us on {{club.phone}}.

Thank you,
{{club.name}}$mt$,
   $mt$Invoice {{invoice.number}} due {{invoice.due_date}}$mt$, $mt$Tap to view the invoice from {{club.name}}.$mt$, NULL, 160),
  ($mt$mt_friday_social$mt$, $mt$friday_social$mt$, $mt$Friday social play invitation$mt$, 'GENERAL', 'ANNOUNCEMENT', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Hello from {{club.name}}!

You're invited to *Friday social play* this week — meet other members, get mixed into friendly games and stay for the evening. *All levels welcome.*

See the time and book your place: {{link}}
Questions? Call {{club.phone}}.$mt$,
   $mt$You're invited: Friday social play at {{club.name}}$mt$,
   $mt$Hello from {{club.name}}!

You're invited to Friday social play this week. Meet other members, get mixed into friendly games and stay on for the evening at the club. All levels are welcome.

See the start time and book your place with the button below — places are limited.

Questions? Call us on {{club.phone}}.

See you on Friday,
{{club.name}}$mt$,
   $mt$Friday social play$mt$, $mt$Join us this Friday at {{club.name}} — all levels welcome. Tap to book your place.$mt$, NULL, 170),
  ($mt$mt_club_notice$mt$, $mt$club_notice$mt$, $mt$Club notice (closure / timing change)$mt$, 'GENERAL', 'ANNOUNCEMENT', ARRAY['WHATSAPP', 'EMAIL', 'PUSH']::text[],
   $mt$Notice from {{club.name}}:

*[[What is changing and when — e.g. Courts 1 and 2 are closed on Sunday 12 Oct, 6–10 am, for resurfacing]]*

We're sorry for any inconvenience. Questions? Call {{club.phone}}.$mt$,
   $mt$Notice from {{club.name}}: [[closure or new timings]]$mt$,
   $mt$Hello,

[[What is changing and when — e.g. Courts 1 and 2 are closed on Sunday 12 Oct, 6–10 am, for resurfacing. All other courts are open as usual.]]

We're sorry for any inconvenience. Questions? Call us on {{club.phone}}.

Thank you,
{{club.name}}$mt$,
   $mt$Notice from {{club.name}}$mt$, $mt$[[Closure or new timings, in one line]]$mt$, NULL, 180)
ON CONFLICT DO NOTHING;
INSERT INTO "message_template_versions" ("id", "template_id", "version", "name", "context", "category", "channels", "whatsapp_text",
                                         "email_subject", "email_body", "push_title", "push_body", "wa_template")
SELECT 'mtv_' || t."key" || '_1', t."id", 1, t."name", t."context", t."category", t."channels", t."whatsapp_text",
       t."email_subject", t."email_body", t."push_title", t."push_body", t."wa_template"
  FROM "message_templates" t
 WHERE t."key" IS NOT NULL AND t."version" = 1
ON CONFLICT DO NOTHING;
-- <<< ready-made templates
