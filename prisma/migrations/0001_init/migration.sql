-- Injectable clock for created_at defaults (see 0002 and DECISIONS.md D-04).
CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz AS $$
  SELECT coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now())
$$ LANGUAGE sql STABLE;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'FRONT_DESK', 'SHOP_STAFF', 'BAR_STAFF', 'ACCOUNTANT', 'MEMBER');

-- CreateEnum
CREATE TYPE "PlanCode" AS ENUM ('GOLD', 'SILVER', 'JUNIOR');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING_PAYMENT', 'SCHEDULED', 'ACTIVE', 'EXPIRED', 'CHANGED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Sport" AS ENUM ('TENNIS', 'CRICKET', 'PADEL', 'BADMINTON');

-- CreateEnum
CREATE TYPE "ReservationKind" AS ENUM ('REGULAR', 'SOCIAL', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "BookingChannel" AS ENUM ('FRONT_DESK', 'PHONE', 'MESSAGE', 'WALK_IN', 'ONLINE_MEMBER', 'ONLINE_TRIAL');

-- CreateEnum
CREATE TYPE "SocialStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ParticipantStatus" AS ENUM ('JOINED', 'LEFT');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('RACKETS', 'BALLS', 'SHOES', 'ACCESSORIES', 'APPAREL', 'SERVICES');

-- CreateEnum
CREATE TYPE "StockReason" AS ENUM ('RECEIPT', 'COUNTER_SALE', 'RESERVE', 'RELEASE', 'ONLINE_FULFIL', 'ADJUSTMENT', 'RETURN');

-- CreateEnum
CREATE TYPE "Fulfilment" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "PaymentOption" AS ENUM ('ONLINE', 'PAY_AT_PICKUP');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'READY_FOR_PICKUP', 'COLLECTED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'READY', 'COLLECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MenuCategory" AS ENUM ('FOOD', 'BEVERAGE', 'ALCOHOL');

-- CreateEnum
CREATE TYPE "TabStatus" AS ENUM ('OPEN', 'SETTLED', 'CARRIED', 'VOID');

-- CreateEnum
CREATE TYPE "TabLineStatus" AS ENUM ('NEW', 'PREPARING', 'READY', 'SERVED', 'VOID');

-- CreateEnum
CREATE TYPE "BillSource" AS ENUM ('BOOKING', 'SOCIAL_JOIN', 'COUNTER_SALE', 'SHOP_ORDER', 'SERVICE_TICKET', 'BAR_TAB', 'MEMBERSHIP', 'INVOICE');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'VOID', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('PAYMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'UPI', 'ONLINE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LedgerSource" AS ENUM ('COURTS', 'SOCIAL', 'SHOP', 'BAR', 'MEMBERSHIP', 'INVOICE', 'EXPENSE', 'PAYROLL');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WEBSITE_ENQUIRY', 'TRIAL_BOOKING', 'WALK_IN', 'PHONE', 'REFERRAL');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUOTED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('CALL', 'NOTE', 'EMAIL', 'QUOTE_SENT', 'INTERESTED', 'STATUS_CHANGE', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('SENT', 'INTERESTED', 'ACCEPTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ShiftArea" AS ENUM ('FRONT_DESK', 'BAR', 'KITCHEN', 'SHOP', 'COURTS');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('ASSIGNED', 'OPEN');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('CASUAL', 'SICK', 'UNPAID');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('STOCK_PURCHASE', 'UTILITIES', 'RENT', 'MAINTENANCE', 'MARKETING', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('UNPAID', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_set_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "password_set_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "member_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "dob" DATE NOT NULL,
    "photo_url" TEXT,
    "emergency_contact_name" TEXT,
    "emergency_contact_phone" TEXT,
    "next_plan_id" TEXT,
    "next_plan_months" INTEGER,
    "lead_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "id_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" "PlanCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price_1m" INTEGER NOT NULL,
    "price_3m" INTEGER NOT NULL,
    "price_12m" INTEGER NOT NULL,
    "social_fee" INTEGER NOT NULL,
    "shop_discount_pct" INTEGER NOT NULL,
    "bar_discount_pct" INTEGER NOT NULL,
    "advance_booking_days" INTEGER NOT NULL,
    "alcohol_allowed" BOOLEAN NOT NULL,
    "rank" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_court_fees" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "sport" "Sport" NOT NULL,
    "fee" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_court_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "status" "MembershipStatus" NOT NULL,
    "price" INTEGER NOT NULL,
    "credit_applied" INTEGER NOT NULL DEFAULT 0,
    "bill_id" TEXT,
    "changed_from_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'NEW',
    "cancel_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_reminders" (
    "id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "reminder_type" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "membership_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visits" (
    "id" TEXT NOT NULL,
    "member_id" TEXT,
    "guest_id" TEXT,
    "booking_id" TEXT,
    "checked_in_at" TIMESTAMPTZ(3) NOT NULL,
    "checked_out_at" TIMESTAMPTZ(3),
    "by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sport" "Sport" NOT NULL,
    "max_players" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "court_reservations" (
    "id" TEXT NOT NULL,
    "court_id" TEXT NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "kind" "ReservationKind" NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "court_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "booking_code" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "primary_member_id" TEXT,
    "primary_guest_id" TEXT,
    "channel" "BookingChannel" NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "bill_id" TEXT,
    "note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_players" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "member_id" TEXT,
    "guest_id" TEXT,
    "fee_snapshot" INTEGER NOT NULL,
    "tier_snapshot" TEXT NOT NULL,
    "bill_line_id" TEXT,
    "checked_in_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_sessions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "series_id" TEXT,
    "date" DATE NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "capacity_per_court" INTEGER NOT NULL,
    "status" "SocialStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_session_courts" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "court_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_session_courts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_participants" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "member_id" TEXT,
    "guest_id" TEXT,
    "fee_snapshot" INTEGER NOT NULL,
    "tier_snapshot" TEXT NOT NULL,
    "status" "ParticipantStatus" NOT NULL DEFAULT 'JOINED',
    "bill_id" TEXT,
    "channel" "BookingChannel" NOT NULL,
    "checked_in_at" TIMESTAMPTZ(3),
    "left_at" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "category" "ProductCategory" NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "image_url" TEXT,
    "track_stock" BOOLEAN NOT NULL DEFAULT true,
    "is_restring" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "reorder_level" INTEGER NOT NULL,
    "tax_category" TEXT NOT NULL,
    "hsn_sac" TEXT NOT NULL,
    "low_stock_alerted" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "qty_on_hand_delta" INTEGER NOT NULL,
    "qty_reserved_delta" INTEGER NOT NULL,
    "reason" "StockReason" NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "unit_cost" INTEGER,
    "note" TEXT,
    "actor_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counter_sales" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "member_id" TEXT,
    "guest_id" TEXT,
    "bill_id" TEXT NOT NULL,
    "sold_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "counter_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_orders" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "member_id" TEXT,
    "guest_id" TEXT,
    "fulfilment" "Fulfilment" NOT NULL,
    "address" TEXT,
    "delivery_fee" INTEGER NOT NULL DEFAULT 0,
    "payment_option" "PaymentOption" NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(3),
    "bill_id" TEXT NOT NULL,
    "cancel_reason" TEXT,
    "track_token" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_order_lines" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "net_amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_order_events" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "note" TEXT,
    "actor_id" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shop_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_tickets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "member_id" TEXT,
    "guest_id" TEXT,
    "customer_name" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "racket" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" "TicketStatus" NOT NULL DEFAULT 'RECEIVED',
    "promised_at" TIMESTAMPTZ(3) NOT NULL,
    "bill_id" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "MenuCategory" NOT NULL,
    "price" INTEGER NOT NULL,
    "is_alcoholic" BOOLEAN NOT NULL,
    "tax_category" TEXT NOT NULL,
    "hsn_sac" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bar_tables" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "area" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bar_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tabs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "member_id" TEXT,
    "guest_id" TEXT,
    "table_id" TEXT,
    "status" "TabStatus" NOT NULL DEFAULT 'OPEN',
    "guest_id_verified" BOOLEAN NOT NULL DEFAULT false,
    "opened_by" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "bar_date" DATE NOT NULL,
    "carried_reason" TEXT,
    "carried_by" TEXT,
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tab_lines" (
    "id" TEXT NOT NULL,
    "tab_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "bill_line_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "discount_pct" INTEGER NOT NULL,
    "discount_amount" INTEGER NOT NULL,
    "net_amount" INTEGER NOT NULL,
    "note" TEXT,
    "status" "TabLineStatus" NOT NULL DEFAULT 'NEW',
    "kitchen_ticket_id" TEXT,
    "added_by" TEXT NOT NULL,
    "preparing_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "served_at" TIMESTAMPTZ(3),
    "voided_by" TEXT,
    "void_reason" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tab_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_tickets" (
    "id" TEXT NOT NULL,
    "tab_id" TEXT NOT NULL,
    "table_id" TEXT,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bar_days" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_by" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" TEXT NOT NULL,
    "source_type" "BillSource" NOT NULL,
    "source_id" TEXT,
    "member_id" TEXT,
    "guest_id" TEXT,
    "business_client_id" TEXT,
    "customer_name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "tax_total" INTEGER NOT NULL DEFAULT 0,
    "discount_total" INTEGER NOT NULL DEFAULT 0,
    "amount_paid" INTEGER NOT NULL DEFAULT 0,
    "amount_refunded" INTEGER NOT NULL DEFAULT 0,
    "status" "BillStatus" NOT NULL DEFAULT 'UNPAID',
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_lines" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "discount_pct" INTEGER NOT NULL,
    "discount_amount" INTEGER NOT NULL,
    "net_amount" INTEGER NOT NULL,
    "tax_rate" INTEGER NOT NULL,
    "tax_amount" INTEGER NOT NULL,
    "tax_category" TEXT NOT NULL,
    "hsn_sac" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "variant_id" TEXT,
    "menu_item_id" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "type" "PaymentType" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "reference" TEXT,
    "gateway" TEXT,
    "gateway_order_id" TEXT,
    "gateway_payment_id" TEXT,
    "tendered" INTEGER,
    "change_given" INTEGER,
    "received_by" TEXT,
    "shift_id" TEXT,
    "refund_of_id" TEXT,
    "failure_reason" TEXT,
    "note" TEXT,
    "return_url" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "source" "LedgerSource" NOT NULL,
    "direction" "Direction" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "tax_amount" INTEGER NOT NULL DEFAULT 0,
    "bill_id" TEXT,
    "payment_id" TEXT,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "description" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "actor_key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_json" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "state_code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 15,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "number" TEXT,
    "fy" TEXT,
    "seq" INTEGER,
    "kind" TEXT NOT NULL,
    "business_client_id" TEXT,
    "member_id" TEXT,
    "place_of_supply" TEXT NOT NULL,
    "issue_date" DATE,
    "due_date" DATE,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "bill_id" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "overdue_notified_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_counters" (
    "fy" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("fy")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "source" "LeadSource" NOT NULL,
    "interest" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL DEFAULT '',
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "lost_reason" TEXT,
    "assigned_to" TEXT,
    "next_follow_up_at" TIMESTAMPTZ(3) NOT NULL,
    "overdue_notified_at" TIMESTAMPTZ(3),
    "member_id" TEXT,
    "guest_id" TEXT,
    "booking_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "note" TEXT NOT NULL,
    "by_user_id" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'SENT',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "monthly_salary" INTEGER NOT NULL,
    "join_date" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT,
    "previous_employee_id" TEXT,
    "date" DATE NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "area" "ShiftArea" NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'ASSIGNED',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "shift_id" TEXT,
    "clock_in" TIMESTAMPTZ(3) NOT NULL,
    "clock_out" TIMESTAMPTZ(3),
    "opening_float" INTEGER NOT NULL DEFAULT 0,
    "cash_expected" INTEGER,
    "cash_counted" INTEGER,
    "variance" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "type" "LeaveType" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "method" "PaymentMethod",
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "gross" INTEGER NOT NULL,
    "unpaid_days" INTEGER NOT NULL,
    "deductions" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "method" "PaymentMethod",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_bills" (
    "id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "amount" INTEGER NOT NULL,
    "input_gst" INTEGER NOT NULL DEFAULT 0,
    "bill_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'UNPAID',
    "paid_at" TIMESTAMPTZ(3),
    "method" "PaymentMethod",
    "ref_type" TEXT,
    "ref_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expense_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dedupe_key" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "report_params" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT app_now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "password_set_tokens_token_hash_key" ON "password_set_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "members_user_id_key" ON "members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "members_member_code_key" ON "members"("member_code");

-- CreateIndex
CREATE UNIQUE INDEX "members_phone_key" ON "members"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "guests_phone_key" ON "guests"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plan_court_fees_plan_id_sport_key" ON "plan_court_fees"("plan_id", "sport");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_bill_id_key" ON "memberships"("bill_id");

-- CreateIndex
CREATE INDEX "memberships_member_id_idx" ON "memberships"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_reminders_membership_id_reminder_type_key" ON "membership_reminders"("membership_id", "reminder_type");

-- CreateIndex
CREATE INDEX "visits_member_id_idx" ON "visits"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "courts_name_key" ON "courts"("name");

-- CreateIndex
CREATE INDEX "court_reservations_court_id_start_at_idx" ON "court_reservations"("court_id", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_booking_code_key" ON "bookings"("booking_code");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_reservation_id_key" ON "bookings"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_bill_id_key" ON "bookings"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_players_bill_line_id_key" ON "booking_players"("bill_line_id");

-- CreateIndex
CREATE INDEX "booking_players_member_id_idx" ON "booking_players"("member_id");

-- CreateIndex
CREATE INDEX "booking_players_guest_id_idx" ON "booking_players"("guest_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_session_courts_reservation_id_key" ON "social_session_courts"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_participants_bill_id_key" ON "social_participants"("bill_id");

-- CreateIndex
CREATE INDEX "social_participants_member_id_idx" ON "social_participants"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "stock_movements_variant_id_idx" ON "stock_movements"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "counter_sales_code_key" ON "counter_sales"("code");

-- CreateIndex
CREATE UNIQUE INDEX "counter_sales_bill_id_key" ON "counter_sales"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_orders_code_key" ON "shop_orders"("code");

-- CreateIndex
CREATE UNIQUE INDEX "shop_orders_bill_id_key" ON "shop_orders"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_orders_track_token_key" ON "shop_orders"("track_token");

-- CreateIndex
CREATE UNIQUE INDEX "service_tickets_code_key" ON "service_tickets"("code");

-- CreateIndex
CREATE UNIQUE INDEX "bar_tables_number_key" ON "bar_tables"("number");

-- CreateIndex
CREATE UNIQUE INDEX "tabs_code_key" ON "tabs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tabs_bill_id_key" ON "tabs"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "tab_lines_bill_line_id_key" ON "tab_lines"("bill_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "bar_days_date_key" ON "bar_days"("date");

-- CreateIndex
CREATE INDEX "bills_source_type_source_id_idx" ON "bills"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "bills_member_id_idx" ON "bills"("member_id");

-- CreateIndex
CREATE INDEX "bill_lines_bill_id_idx" ON "bill_lines"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_gateway_payment_id_key" ON "payments"("gateway_payment_id");

-- CreateIndex
CREATE INDEX "payments_bill_id_idx" ON "payments"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_payment_id_key" ON "ledger_entries"("payment_id");

-- CreateIndex
CREATE INDEX "ledger_entries_occurred_at_idx" ON "ledger_entries"("occurred_at");

-- CreateIndex
CREATE INDEX "ledger_entries_bill_id_idx" ON "ledger_entries"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_actor_key_key" ON "idempotency_keys"("key", "actor_key");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_bill_id_key" ON "invoices"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_fy_number_key" ON "invoices"("fy", "number");

-- CreateIndex
CREATE UNIQUE INDEX "leads_code_key" ON "leads"("code");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_token_key" ON "quotes"("token");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE INDEX "attendance_employee_id_idx" ON "attendance"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_month_key" ON "payroll_runs"("month");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_run_id_employee_id_key" ON "payslips"("run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_dedupe_key_key" ON "email_outbox"("dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_key" ON "share_links"("token");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_idx" ON "audit_logs"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_at_idx" ON "audit_logs"("at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_set_tokens" ADD CONSTRAINT "password_set_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_next_plan_id_fkey" FOREIGN KEY ("next_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_court_fees" ADD CONSTRAINT "plan_court_fees_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "court_reservations" ADD CONSTRAINT "court_reservations_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "court_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_players" ADD CONSTRAINT "booking_players_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_session_courts" ADD CONSTRAINT "social_session_courts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "social_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_session_courts" ADD CONSTRAINT "social_session_courts_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "court_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_participants" ADD CONSTRAINT "social_participants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "social_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order_lines" ADD CONSTRAINT "shop_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order_events" ADD CONSTRAINT "shop_order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tab_lines" ADD CONSTRAINT "tab_lines_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "tabs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

