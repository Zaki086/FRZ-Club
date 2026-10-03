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

`npm run worker` runs the scheduled jobs (every 30 seconds: queued WhatsApp messages; every minute: notification
deliveries (push / email / WhatsApp API); every 5 minutes: no-shows/completions, order holds, overdue and escalated
leads, stale gateway payments, email outbox, missing clock-outs, scheduled price changes, session and social-play
reminders 2 hours before, club-cancellation choice reminders (day 3 and day 6, daytime); daily 00:05 IST: membership
expiry + reminders, dues reminders, overdue invoices, low-stock digest, expired leave requests, club-cancelled bookings
with no choice → refund, reminders for refunds not yet collected).

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
                                 # + champions-https (HTTPS on its own port, see below)
pm2 save                         # restored automatically after a reboot (pm2 startup)
```

Set `APP_URL` in `.env` to the address people use; it is used in links sent to members. Postgres runs with
`restart: unless-stopped`. Over plain HTTP the session cookie is not marked `Secure` (browsers would drop it); behind
HTTPS it is. Dev tools (time travel) are disabled in production by design.

### HTTPS

The camera QR scan, Web Push and secure cookies need HTTPS. Two ways (details in `PROGRESS.md`, v3 phase 1):
- **A reverse proxy** you control (Caddy/nginx) with a real domain, forwarding to `127.0.0.1:3200` — the recommended
  set-up; the exact Caddy block is in `PROGRESS.md`.
- **Its own HTTPS port with a Let's Encrypt certificate** (what this server uses, because ports 80/443 belong to another
  project): PM2 `champions-https` (`scripts/https.mjs`) serves `https://<HTTPS_HOSTS[0]>:<HTTPS_PORT>` and forwards to
  `127.0.0.1:3200`. The certificate covers sslip.io / nip.io names such as `champions.38-49-215-124.sslip.io`; it is
  obtained and renewed (30 days before expiry, no restart) with the DNS-01 challenge, which sslip.io and nip.io delegate
  to the IP inside the name — the script answers it on `HTTPS_DNS_BIND:53` only while `lego` runs (put the lego binary
  in `.bin/lego`; `node scripts/https.mjs --issue-only --staging` tries Let's Encrypt staging first). Set
  `HTTPS_HOSTS` (comma-separated names, the first is the public address), `HTTPS_PORT` (default 3443),
  `HTTPS_DNS_BIND` (this server's public IP) and optionally `ACME_EMAIL`, and `APP_URL=https://<first name>:<port>`.
  Live address: https://champions.38-49-215-124.sslip.io:3443

When `APP_URL` is HTTPS, plain-HTTP visits to that host are redirected (308; host names are compared without the
port) and HSTS is sent.

### Web Push

```bash
npm run vapid:generate          # prints a VAPID key pair for .env (once per installation)
```

Put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`mailto:` the club's email; when empty the club email
from Settings is used) in `.env` and restart the web and worker processes; keep the private key secret, and note that
changing the keys later makes every device turn push on again. Browsers allow push only on HTTPS, so push
is offered only when `APP_URL` is `https://` and both keys are set. Nobody is asked on page load: members see a "Get
alerts for bookings, refunds and renewals" card on the portal home, staff in My Account; on an iPhone, alerts work
only after "Add to Home Screen" (iOS 16.4+). Each person's devices are listed in their notification settings with
Remove. Non-urgent pushes are held from 22:00 to 07:00 IST; session reminders and same-day club cancellations go at once.

### WhatsApp (Meta WhatsApp Cloud API)

Club cancellations, reschedules and refunds are sent automatically on WhatsApp once this is set up (welcome, expiry
and dues too, if their optional templates are approved). Without it, every message still goes out in the app, by push
and by email, and WhatsApp becomes a task in **Messages to Send** for the desk to send from the club phone.

1. In Meta for Developers, create an app with the WhatsApp product and connect the club's WhatsApp Business Account
   and phone number.
2. Business Settings → System users: create a system user with access to the app and the WhatsApp account, and
   generate a permanent token with `whatsapp_business_messaging` and `whatsapp_business_management` →
   `WHATSAPP_ACCESS_TOKEN`.
3. WhatsApp → API Setup: the number's Phone number ID → `WHATSAPP_PHONE_NUMBER_ID`; the WhatsApp Business Account ID →
   `WHATSAPP_BUSINESS_ACCOUNT_ID`.
4. App settings → Basic: the App secret → `WHATSAPP_APP_SECRET` (checks the webhook's `X-Hub-Signature-256`).
5. A long random string of your choice → `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; the Graph API version shown in Meta's
   dashboard (e.g. `v23.0`) → `WHATSAPP_GRAPH_API_VERSION` (the code has no default). Restart the web and worker
   processes.
6. WhatsApp → Configuration: callback URL `<APP_URL>/api/whatsapp/webhook`, verify token = the value of
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, subscribe to **messages**. Settings → WhatsApp then shows "Webhook verified".
7. WhatsApp Manager → Message templates: submit the eight required templates (and, if wanted, the three optional ones)
   exactly as written in `docs/whatsapp-templates.md` (category Utility, English) and wait for Meta's approval.
8. Settings → WhatsApp (Owner): **Check access token**, map each template (name + language code), **Fetch templates**
   (shows which are APPROVED), then **Send test message** to a phone. Automatic sending is on only after the token
   check and a successful test message, and each event uses WhatsApp only while its template is mapped and APPROVED.

Only people who ticked "Send me booking and refund updates on WhatsApp" (sign-up, trial and enquiry forms, or Portal →
Notifications) get automatic messages; a reply of STOP turns it off for that number, and any other reply becomes a
task in Messages to Send. Meta charges per message.

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
one part-paid, one overdue), a completed payroll run, three tills (Front Desk Till 1, Shop Till, Bar Till) with daily
sessions — a 14:00 handover at the desk, drops to the safe, bank deposits on Tuesdays and Fridays, a few variances
(the latest still waiting for approval) — and Court 1 free this evening for the demo. The sample club takes cash and
card; UPI is off (its sample UPI ID receives no money) until the Owner enters and confirms a real one in Settings →
Payments & services. A real club chooses its methods there too (the live club currently takes cash only).

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
| Push notifications | HTTPS `APP_URL` + `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (`npm run vapid:generate`) + `VAPID_SUBJECT`; each person turns it on per device (see Web Push above) |
| WhatsApp (automatic) | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_GRAPH_API_VERSION`; then Settings → WhatsApp: token check, templates mapped and APPROVED (`docs/whatsapp-templates.md`), a successful test message; people must opt in. Meta charges per message. Otherwise WhatsApp messages wait under **Messages to Send** for the desk to send from the club phone |

### The cash drawer day

Every counter that takes cash has a till; the Owner sets tills, default floats, note/coin denominations, blind close
and the variance tolerance in Settings → Cash drawers.

1. **Open** — on My Cash Drawer (`/app/drawer`) the staff member picks the till and counts the float by denomination.
   Counter payments and refunds need an open drawer (`DRAWER_NOT_OPEN`); one person per till, one till per person.
2. **Payments** — the cash dialog asks for the amount tendered and shows the change; the drawer grows by the amount
   applied to the bill, at once (header badge and My Cash Drawer). Change must already be in the till
   (`INSUFFICIENT_CHANGE` → Pay in).
3. **Refunds** — an approved cash refund waits at the desk as "Ready to collect" with a refund code and QR. The desk
   scans or searches it, compares the member photo, ticks "Identity checked", pays it from the drawer
   (`INSUFFICIENT_CASH_IN_DRAWER` when the till can't cover it) and prints the receipt.
4. **Drops** — Cash drop moves excess cash to the safe with a sealed-bag reference; Pay in (from the safe) and Pay out
   (petty cash, recorded as a paid expense) need a reason.
5. **Close** — a blind count by denomination, then expected, counted and the variance are shown. Within the tolerance
   (₹50) the session closes; above it the staff member gives a reason and it waits in the Manager/Owner "Needs your
   approval" panel. The float left for the next shift stays in the till; the rest goes to the safe. A handover is a
   close and an open of the same till.
6. **Reconciliation** (`/app/finance/cash`) — ledger cash vs drawer movements, refunds, variances, drops vs the safe,
   and bank deposits; every line reconciles or shows the difference in red with a link. The Owner sees every till,
   the safe and the bank deposits on Cash Drawers (`/app/finance/drawers`).

### Refunds and messages

Every refund is a **refund request** (`/app/refunds`): refunds a rule requires (in-time cancellation, club
cancellation, over-payment, return window) are approved automatically; others — including members' requests from the
portal — need a Manager (up to the limit in Settings) or the Owner, and never the person who asked. Money goes back the
way it came: online through the gateway; otherwise it waits at the desk — cash as "Ready to collect" (above), UPI or
card paid out with its reference. Uncollected refunds never expire: members are reminded after 3 and 7 days, then every 14 days
(at most 4 reminders), and the Owner sees them as **Refunds payable** under "What we owe". Members follow each refund
in Portal → Refunds and see every payment in Portal → Payments.

Members get every message (welcome with their login link, renewals, expiry and dues reminders, bookings, session
reminders, refunds, club cancellations) in the app and on each channel that works and they haven't turned off — push,
email, and WhatsApp (automatic for those who opted in, otherwise a task in Messages to Send). The **Notification log**
(`/app/messages`) records every attempt per channel — a channel that isn't available is recorded as not available,
never as sent; the Owner's Message Log (`/app/settings/messages` → WhatsApp) shows each WhatsApp message's status
timeline (sent → delivered → read, or the error).

## Where things are

| Area | URL |
|---|---|
| Public website | `/`, `/plans`, `/availability`, `/shop`, `/trial`, `/enquire`, `/quote/[token]` |
| Signed links (no login) | `/r/<token>` — choose a new time or a refund after a club cancellation (sent on WhatsApp to the booker); `/rq/<token>` — a refund's collection QR |
| Member portal | `/portal` (card QR, book, social, bookings, orders, tab, invoices, membership, refunds, payments) |
| Staff app | `/app` (dashboard per role) — front desk `/app/desk` (check-in risk `/app/desk/risk`, renewals & dues `/app/desk/expiring`), my cash drawer `/app/drawer`, refunds `/app/refunds`, courts `/app/courts` (Close courts), shop `/app/shop` (products `/app/shop/products`), bar `/app/bar`, KDS `/app/bar/kds`, CRM `/app/crm`, messages `/app/messages`, notifications `/app/notifications`, price book `/app/pricing`, employees `/app/employees`, finance `/app/finance/*` (cash drawers, safe and bank deposits `/app/finance/drawers`, cash reconciliation `/app/finance/cash`), staff `/app/staff/*` (directory, attendance, roster, leave), reports `/app/reports`, settings `/app/settings` |
| Menus and access | The Owner, Manager and Front desk menus are fixed lists (`src/app/(staff)/app/_nav.ts`); the other roles' menus are unchanged. For the Manager and the Front desk, a staff page that is not on their menu answers 403, except detail pages opened from a listed page (a member, a refund, a receipt…); the Owner can open any page by its address. The Owner's and Manager's dashboards start with **Needs your approval** (refunds within their limit, leave, missing clock-outs, drawer variances). The price book is the Owner's alone |
| Lists | Every list has the same filter bar: search, date presets, filters with counts, sort, 25/50/100 per page, chips, CSV export (roles that may export) and saved views; the filters live in the address, so a view can be shared |
| Webhooks | Razorpay `POST /api/payments/razorpay/webhook`; WhatsApp Cloud API `GET/POST /api/whatsapp/webhook` (the older `/api/webhooks/whatsapp` still answers) |
| Razorpay webhook | `POST /api/payments/razorpay/webhook` (set the same secret as `RAZORPAY_WEBHOOK_SECRET`) |
| Dev tools | `/app/settings/dev` — time travel and "Run all jobs now" (disabled in production; on no menu, the Owner opens it by its address) |

## Tests and checks

```bash
npm run typecheck
npm run lint
npm test                    # Vitest: rule tests + concurrency tests on the real champions_test database
npm run verify:integrity    # the §9 checklist (13 checks) against the dev database
npm run demo:race           # with the app running: 20 simultaneous bookings → exactly 1 success, 19 SLOT_TAKEN
npm run test:e2e            # Playwright (needs `npx playwright install chromium` once): the §12 demo, the
                            # click-through UI flows twice (cash only; card + UPI), the v4 flows (menus, cash drawer,
                            # refunds, push, WhatsApp) and a fresh install on its own port and database.
                            # Run on fresh sample data: ALLOW_DEMO_RESET=1 npm run demo:reset
npm run audit:dummy         # is anything fake left? source scan + every role × page on desktop and 360 px → AUDIT.md
```

The rule tests are named after the rule they prove (e.g. `BK-4: a partner who already has 2 plays is rejected…`).
Concurrency tests (`tests/concurrency/`) cover the 20-way court race, the daily-limit race, the last-racket race
across counter and online, and the last social spot.

## Finance exports, files and backups

- **GST report** (`/app/finance/gst`, only when GST is on): tax by rate and category, CGST/SGST vs IGST; alcohol is
  listed separately as outside GST. Downloads: summary CSV, **GSTR-1** working tables (B2B, B2CS, HSN summary) and a
  **Tally day book** (also on the Ledger page). Report support only — check with your tax advisor before filing.
- **Files** are stored on the server under `UPLOAD_DIR` (default `uploads/`): product photos (public), expense bills
  (finance only) and bank deposit slips (Owner, Manager, Accountant), at most 2 MB, type checked from the file itself. Products without a photo show their category icon.
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
- **Cash:** drawer and safe movements are append-only, each with its running balance, written in the same transaction
  as the payment or refund; integrity checks #12–#13 prove they match the cash payments and refunds and add up.
- **Prices:** base prices are dated versions and rules are never edited in place (a change ends one version and starts
  the next), so any price can be explained and bills — snapshots — never change afterwards.
- **Messages:** exactly one delivery record per message and channel (unique index), so a reminder is never sent twice.
  Messages are queued in the same transaction as the change they report and sent only after it commits (a rollback
  sends nothing); rows are claimed with `FOR UPDATE SKIP LOCKED`, so two workers never send the same one.

See `PROGRESS.md` (requirement-by-requirement status with files and tests) and `DECISIONS.md` (choices made where the plan was silent).
