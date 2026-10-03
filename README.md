# The Champions Club — Sports Club Management System

One member → one operational identity → every club transaction. Courts, social play, the gear shop, the bar &
cafeteria, memberships, CRM, invoices, payroll and the owner dashboard all run on **one pricing engine** and
**one append-only ledger**, so every number on the dashboard reconciles to the records behind it.

Stack: Next.js 16 (App Router) · TypeScript strict · PostgreSQL 16 (`btree_gist`) · Prisma + raw SQL migrations ·
Zod · Tailwind + shadcn-style UI · Vitest on a real Postgres · Playwright · node-cron worker.

## Setup (5 commands)

Requirements: Node 22+, Docker with the compose plugin.

```bash
docker compose up -d            # Postgres 16 with btree_gist (+ a champions_test database for the test suite)
npm i                           # also creates .env from .env.example in development (DB on port 5442, app on 3200)
npm run db:migrate              # prisma migrate deploy (incl. raw SQL constraints) + prisma generate
npm run seed:demo               # OPTIONAL sample club: 60 days of history through the real services (~3 min)
npm run dev                     # http://localhost:3200   — and in a second terminal:  npm run worker
```

`npm run worker` runs the scheduled jobs (every 5 minutes: no-shows/completions, order holds, overdue and escalated
leads, stale gateway payments, email outbox, notification deliveries (push / email / WhatsApp API), missing clock-outs,
scheduled price changes; daily 00:05 IST: membership expiry + reminders, dues reminders, overdue invoices, low-stock
digest, expired leave requests, club-cancelled bookings with no choice → refund).

### A real club (first run)

```bash
npm run db:migrate
npm run create-owner -- --name "Owner Name" --phone 98XXXXXXXX --email owner@yourclub.in   # asks for the password
npm run build && pm2 start ecosystem.config.cjs
```

The Owner logs in and the **setup wizard** (`/setup`) opens first: club details (and GSTIN, if registered), GST
rates, how the club takes payments, courts and plan prices. The staff app stays closed until it is finished. Other
staff are then added in Settings → Users & roles.

### Sample club (optional)

`seed:demo` needs `SEED_STAFF_PASSWORD` and `SEED_MEMBER_PASSWORD` (8+ characters) in `.env`; those are the
passwords of the sample logins. It only runs on an empty database, marks it `SAMPLE_DATA` (every page shows a
banner), and refuses to touch a database with real club data. To rebuild the sample club:
`ALLOW_DEMO_RESET=1 npm run demo:reset`.

### Run it 24/7 with PM2

```bash
npm run build
pm2 start ecosystem.config.cjs   # champions-web (port 3200, all interfaces) + champions-worker (scheduled jobs)
pm2 save                         # restored automatically after a reboot (pm2 startup)
```

Set `APP_URL` in `.env` to the address people use; it is used in links sent to members. Postgres runs with
`restart: unless-stopped`. Over plain HTTP the session cookie is not marked `Secure` (browsers would drop it); behind
HTTPS it is. Dev tools (time travel) are disabled in production by design.

### HTTPS

The camera QR scan, Web Push and secure cookies need HTTPS. Two ways (details in `PROGRESS.md`, v3 phase 1):
- **A reverse proxy** you control (Caddy/nginx) with a real domain, forwarding to `127.0.0.1:3200` — the recommended
  set-up; the exact Caddy block is in `PROGRESS.md`.
- **A Cloudflare quick tunnel** (what this server uses, because ports 80/443 belong to another project): the PM2 app
  `champions-tunnel` (`scripts/tunnel.mjs`) keeps `APP_URL` in step with the tunnel's address (in `.tunnel-url`) and
  restarts only the web and worker processes when it changes. The address changes when the tunnel restarts.

When `APP_URL` is HTTPS, plain-HTTP visits to that host are redirected (308) and HSTS is sent.

## Sample logins (only after `npm run seed:demo`)

Passwords are the `SEED_STAFF_PASSWORD` / `SEED_MEMBER_PASSWORD` values from your `.env` — they are not written
anywhere in the code or the docs. Log in at `/login` with phone or email. All identities are fictitious.

| Role | Name | Email | Phone |
|---|---|---|---|
| OWNER | Vikram Rao | owner@championsclub.example | 9000000001 |
| MANAGER | Meera Iyer | manager@championsclub.example | 9000000002 |
| FRONT_DESK | Farah Khan | desk@championsclub.example | 9000000003 |
| FRONT_DESK | Dev Patel | desk2@championsclub.example | 9000000004 |
| SHOP_STAFF | Sameer Joshi | shop@championsclub.example | 9000000005 |
| BAR_STAFF | Bina Thomas | bar@championsclub.example | 9000000006 |
| BAR_STAFF | Raju Nair | bar2@championsclub.example | 9000000007 |
| ACCOUNTANT | Anita Desai | accounts@championsclub.example | 9000000008 |
| KITCHEN | Suresh Kumar | kitchen@championsclub.example | 9000000009 |

### Demo personas (members)

| Persona | Plan | Phone (login) | Notes |
|---|---|---|---|
| Rahul Mehta | Gold, 12 months | 9811000001 | Courts free, 15 % shop/bar discount, books 7 days ahead |
| Neha Kapoor | Silver, 3 months | 9811000002 | ₹150 court fee, 10 % discounts |
| Aarav Shah | Junior, age 15 | 9811000003 | ₹100 court fee, alcohol is always refused |

The seed also leaves: one racket with exactly 1 unit (**Pro Staff 97 v14**), a few items below reorder level,
members expiring within 7 days and already expired, a Junior turning 18 this week, a weekly **Friday Social**
series (Courts 3–4, 19:00–22:00), leads in every status (some overdue), three business clients (one invoice paid,
one part-paid, one overdue), a completed payroll run, daily cash-drawer sessions (a few with a variance) and Court 1
free this evening for the demo. The sample club takes cash and card; UPI is off (its sample UPI ID receives no money)
until the Owner enters and confirms a real one in Settings → Payments & services.

## Real or absent

The app only offers what the club can really do (Settings → Payments & services shows each capability and why):

| Capability | On when |
|---|---|
| Cash | always |
| Card | the Owner ticks "the club has a working card machine" — each payment records the approval code + last 4 |
| UPI | a valid club UPI ID is entered **and** confirmed by the Owner — each payment records the 12-character UTR |
| Online payment | **live** Razorpay keys (`rzp_live_…`) + `RAZORPAY_WEBHOOK_SECRET`, verified with Razorpay. Otherwise members pay at the desk, shop orders are pay-at-pickup or pay-on-delivery |
| Email | `SMTP_HOST` + `SMTP_FROM` set and a test email sent from Settings |
| Delivery | switched on with at least one PIN code |
| GST | a GSTIN with a valid check digit **and** tax rates confirmed by the Owner; otherwise no GST is charged |
| Push notifications | HTTPS `APP_URL` + `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`); each person turns it on per device |
| WhatsApp (automatic) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` (+ `WHATSAPP_VERIFY_TOKEN` for the webhook), approved template names in Settings and a successful test message. Meta charges per message. Otherwise WhatsApp messages wait under **Messages to send** for the desk to send from the club phone |

Counter payments and refunds need the staff member's **cash drawer** to be open (`/app/drawer`, which shows what was
collected by method and the cash that should be in it); the accountant reconciles each day at `/app/finance/cash`.
Every refund is a **refund request** (`/app/refunds`): refunds a rule requires (in-time cancellation, club
cancellation, over-payment, return window) are approved automatically; others need a Manager (up to the limit in
Settings) or the Owner, and never the person who asked; money goes back the way it came — through the gateway, or at
the desk with the UPI reference, card reversal reference or cash from an open drawer.

Members get every message (welcome with their login link, renewals, expiry and dues reminders, refunds, club
cancellations) in the app and on each channel that works and they haven't turned off; the **Notification log**
(`/app/messages`) records every attempt per channel — a channel that isn't available is recorded as not available,
never as sent.

## Where things are

| Area | URL |
|---|---|
| Public website | `/`, `/plans`, `/availability`, `/shop`, `/trial`, `/enquire`, `/quote/[token]` |
| Member portal | `/portal` (card QR, book, social, bookings, orders, tab, invoices, membership) |
| Staff app | `/app` (role-scoped dashboard) — front desk `/app/desk` (renewals & dues `/app/desk/expiring`), courts `/app/courts` (Close courts), shop `/app/shop` (products `/app/shop/products`), bar `/app/bar`, KDS `/app/bar/kds`, CRM `/app/crm`, refunds `/app/refunds`, messages `/app/messages`, price book `/app/pricing`, finance `/app/finance/*` (all cash drawers `/app/finance/drawers`), staff `/app/staff/*` (directory, attendance, roster, leave), reports `/app/reports`, settings `/app/settings` |
| Lists | Every list has the same filter bar: search, date presets, filters with counts, sort, 25/50/100 per page, chips, CSV export (roles that may export) and saved views; the filters live in the address, so a view can be shared |
| Webhooks | Razorpay `POST /api/payments/razorpay/webhook`; WhatsApp Cloud API `GET/POST /api/webhooks/whatsapp` |
| Razorpay webhook | `POST /api/payments/razorpay/webhook` (set the same secret as `RAZORPAY_WEBHOOK_SECRET`) |
| Dev tools | `/app/settings/dev` — time travel and "Run all jobs now" (disabled in production) |

## Tests and checks

```bash
npm run typecheck
npm run lint
npm test                    # Vitest: rule tests + concurrency tests on the real champions_test database
npm run verify:integrity    # the §9 checklist against the dev database
npm run demo:race           # with the app running: 20 simultaneous bookings → exactly 1 success, 19 SLOT_TAKEN
npm run test:e2e            # Playwright (needs `npx playwright install chromium` once): the §12 demo, the
                            # click-through UI flows twice (cash only; card + UPI), and a fresh install on its own
                            # port and database. Run on fresh sample data: ALLOW_DEMO_RESET=1 npm run demo:reset
npm run audit:dummy         # is anything fake left? source scan + every role × page on desktop and 360 px → AUDIT.md
```

The rule tests are named after the rule they prove (e.g. `BK-4: a partner who already has 2 plays is rejected…`).
Concurrency tests (`tests/concurrency/`) cover the 20-way court race, the daily-limit race, the last-racket race
across counter and online, and the last social spot.

## Finance exports, files and backups

- **GST report** (`/app/finance/gst`, only when GST is on): tax by rate and category, CGST/SGST vs IGST; alcohol is
  listed separately as outside GST. Downloads: summary CSV, **GSTR-1** working tables (B2B, B2CS, HSN summary) and a
  **Tally day book** (also on the Ledger page). Report support only — check with your tax advisor before filing.
- **Files** are stored on the server under `UPLOAD_DIR` (default `uploads/`): product photos (public) and expense bills
  (finance only), at most 2 MB, type checked from the file itself. Products without a photo show their category icon.
- **Backups** run every night at 02:30 IST into `BACKUP_DIR` (default `backups/`), kept 14 days; the Owner can run one
  and download any from Settings → Backups. Copy them off the server regularly.

## How correctness is guaranteed

- **No double booking (BK-1):** an exclusion constraint on `court_reservations(court_id, period)` — 18:00–19:00 and
  18:30–19:30 overlap and conflict; SQLSTATE `23P01` becomes `SLOT_TAKEN` with the conflicting booking named.
- **2 plays per day (BK-3/BK-4):** every member player's row is locked (`FOR UPDATE`, ordered) before counting, so
  parallel bookings for the same person serialise.
- **One shelf (SH-2…SH-7):** counter and online use the same variant row via atomic conditional updates
  (`on_hand − reserved ≥ q`); CHECK constraints forbid negative or over-reserved stock; every change writes a stock movement.
- **One price list (§5.3):** `pricing.ts` is the only place prices, discounts and GST are computed; confirms recompute.
- **One ledger (§5.10):** append-only (DB trigger), written in the same transaction as each payment/refund/expense/payroll;
  refunds are negative entries under the original source.
- **No hard deletes:** delete-blocking triggers on every transactional table.
- **Idempotency keys** on booking, social join, checkout, payments, settle and gateway callbacks.
- **Refunds:** every refund payment belongs to a refund request; integrity check #11 proves their states and money agree.
- **Prices:** base prices are dated versions and rules are never edited in place (a change ends one version and starts
  the next), so any price can be explained and bills — snapshots — never change afterwards.
- **Messages:** exactly one delivery record per message and channel (unique index), so a reminder is never sent twice.

See `PROGRESS.md` (requirement-by-requirement status with files and tests) and `DECISIONS.md` (choices made where the plan was silent).
