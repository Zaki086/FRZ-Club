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
npm i                           # also creates .env from .env.example (DB on port 5442, app on 3200)
npm run db:migrate              # prisma migrate deploy (incl. raw SQL constraints) + prisma generate
npm run seed                    # 60 days of history through the real services (~3 min), ends with verify:integrity
npm run dev                     # http://localhost:3200   — and in a second terminal:  npm run worker
```

`npm run worker` runs the scheduled jobs (every 5 minutes: no-shows/completions, order holds, overdue leads,
stale gateway payments, email outbox; daily 00:05 IST: membership expiry + reminders, overdue invoices, low-stock digest).

To start over: `npm run db:reset && npm run seed`.

## Logins

All staff passwords: **`champions123`** · all member passwords: **`member123`** · login at `/login` with phone or email.

| Role | Name | Email | Phone |
|---|---|---|---|
| OWNER | Vikram Rao | owner@championsclub.test | 9000000001 |
| MANAGER | Meera Iyer | manager@championsclub.test | 9000000002 |
| FRONT_DESK | Farah Khan | desk@championsclub.test | 9000000003 |
| FRONT_DESK | Dev Patel | desk2@championsclub.test | 9000000004 |
| SHOP_STAFF | Sameer Joshi | shop@championsclub.test | 9000000005 |
| BAR_STAFF | Bina Thomas | bar@championsclub.test | 9000000006 |
| BAR_STAFF | Raju Nair | bar2@championsclub.test | 9000000007 |
| ACCOUNTANT | Anita Desai | accounts@championsclub.test | 9000000008 |

### Demo personas (members)

| Persona | Plan | Phone (login) | Notes |
|---|---|---|---|
| Rahul Mehta | Gold, 12 months | 9811000001 | Courts free, 15 % shop/bar discount, books 7 days ahead |
| Neha Kapoor | Silver, 3 months | 9811000002 | ₹150 court fee, 10 % discounts |
| Aarav Shah | Junior, age 15 | 9811000003 | ₹100 court fee, alcohol is always refused |

The seed also leaves: one racket with exactly 1 unit (**Pro Staff 97 v14**), a few items below reorder level,
members expiring within 7 days and already expired, a Junior turning 18 this week, a weekly **Friday Social**
series (Courts 3–4, 19:00–22:00), leads in every status (some overdue), three business clients (one invoice paid,
one part-paid, one overdue), a completed payroll run and Court 1 free this evening for the demo.

## Where things are

| Area | URL |
|---|---|
| Public website | `/`, `/plans`, `/availability`, `/shop`, `/trial`, `/enquire`, `/quote/[token]` |
| Member portal | `/portal` (card QR, book, social, bookings, orders, tab, invoices, membership) |
| Staff app | `/app` (role-scoped dashboard) — front desk `/app/desk`, courts `/app/courts`, shop `/app/shop`, bar `/app/bar`, KDS `/app/bar/kds`, CRM `/app/crm`, finance `/app/finance/*`, staff `/app/staff/*`, reports `/app/reports`, settings `/app/settings` |
| Test payments | `/pay/test/[paymentId]` — the built-in **TEST MODE** gateway (Razorpay test mode is used instead when `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are set) |
| Dev tools | `/app/settings/dev` — time travel and "Run all jobs now" (disabled in production) |

## Tests and checks

```bash
npm run typecheck
npm run lint
npm test                    # Vitest: rule tests + concurrency tests on the real champions_test database
npm run verify:integrity    # the §9 checklist against the dev database
npm run demo:race           # with the app running: 20 simultaneous bookings → exactly 1 success, 19 SLOT_TAKEN
npm run test:e2e            # Playwright: the §12 demo script (needs `npx playwright install chromium` once)
```

The rule tests are named after the rule they prove (e.g. `BK-4: a partner who already has 2 plays is rejected…`).
Concurrency tests (`tests/concurrency/`) cover the 20-way court race, the daily-limit race, the last-racket race
across counter and online, and the last social spot.

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

See `PROGRESS.md` (requirement-by-requirement status with files and tests) and `DECISIONS.md` (choices made where the plan was silent).
