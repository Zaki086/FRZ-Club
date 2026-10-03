# PROGRESS.md

Status per phase (§13) and per requirement. Every rule test is named after the rule it proves.
Legend: ✅ done and tested · ⚠️ done with a noted limitation · ⬜ not done.

Test files: `tests/integration/phase0-foundation.test.ts` (P0), `phase1-pricing-payments.test.ts` (P1),
`phase2-membership.test.ts` (P2), `phase3-booking.test.ts` (P3), `phase4-shop.test.ts` (P4), `phase5-bar.test.ts` (P5),
`phase6-crm.test.ts` (P6), `phase7-finance-staff.test.ts` (P7), `phase8-dashboard.test.ts` (P8),
`tests/concurrency/booking-races.test.ts`, `tests/concurrency/shop-races.test.ts`, `tests/e2e/demo.spec.ts` (§12).

## Phases

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 Foundation | Docker Postgres + btree_gist, Prisma schema (all §6 tables), raw SQL constraints/triggers/sequences, auth + DB sessions, RBAC matrix, audit, clock, money/time utils, settings, error model, idempotency, layouts | ✅ | P0 tests (13) |
| 1 Pricing + payments + ledger | Pricing engine, bills, counter payments, split payments, Test Gateway + Razorpay on one verification path, refunds, append-only ledger | ✅ | P1 tests (14) |
| 2 Members & memberships | Sign-up, plans, purchase/renew/upgrade/downgrade, expiry job, reminders, QR card, Member 360, expiring list, dues | ✅ | P2 tests (19) |
| 3 Courts & booking | Availability, booking engine BK-1…BK-12, cancellations, player changes, no-shows, social play, maintenance, check-in, command centre | ✅ | P3 tests (23) + booking races (3) |
| 4 Shop & inventory | Catalogue, stock movements, counter POS, online checkout with reservations & holds, pickup/delivery, low stock, restring tickets, returns, receipts → payables | ✅ | P4 tests (14) + shop race (1) |
| 5 Bar POS | Menu, tables, tabs, payer discounts, alcohol rule, KDS, waiter queue, voids, split settle, carry-over, close bar day, shifts & cash close | ✅ | P5 tests (12) |
| 6 Website + CRM | Public pages, 7-day availability, shop front, trial booking, enquiry, leads, round-robin, activities, quotes, conversion, overdue flags | ✅ | P6 tests (8) |
| 7 Finance & staff | Business clients, invoices (FY numbering, CGST/SGST/IGST), GST report, expenses, roster, leave, payroll | ✅ | P7 tests (10) |
| 8 Dashboard & reports | Role-scoped dashboard, period comparison, drill-down = KPI, bar day report, CSV, share links, notification centre | ✅ | P8 tests (8) |
| 9 Seed + hardening | 60-day seed through services, verify:integrity, demo:race, Playwright demo, states/mobile | ✅ / ⚠️ | `npm run seed` → 10/10 integrity PASS; see notes below |

Latest full run (2026-10-03):
- `npm test` → **126/126 passed in 11 files** (rule tests + 5 concurrency tests). On this shared host (load average > 200,
  OOM kills) some tests once exceeded the old 60 s/120 s timeouts, so timeouts were raised (`vitest.config.ts`, `TX_TIMEOUT_MS`).
- `npm run test:e2e` → **11/11 passed** — the whole §12 demo against the production build on the seeded database.
- `npm run demo:race` → `Result: 1 success, 19 SLOT_TAKEN`.
- `npm run seed` → 60 days through the services in ≈170 s, then `verify:integrity` 10/10 PASS (also 10/10 after the e2e run).
- `npm run typecheck`, `npm run lint`, `next build` → clean.

## Requirements (R-01 … R-47)

| ID | Status | Implementation | Proof |
|---|---|---|---|
| R-01 sign-up with identity | ✅ | `services/membership.ts#createMember`, `/app/members/new` (photo capture, emergency contact, optional password / set-password link) | P2 "MB-1…", "MB-3/IN-4…" |
| R-02 three plans | ✅ | `services/plans.ts` (Gold/Silver/Junior, §11.1 defaults), `/plans`, settings editor | P2, P3 pricing |
| R-03 entitlements applied automatically | ✅ | `services/pricing.ts` (court fee per sport, social fee, shop/bar discount, booking window, alcohol) | P3 "Gold ₹0…", P4 "R-24…", P5 "R-27…" |
| R-04 dates, auto expiry, reminders | ✅ | `runMembershipJob` (MB-4, MB-11, dedupe table), worker daily 00:05 | P2 "MB-11: reminders fire…" |
| R-05 recognise quickly | ✅ | `/app/desk` search (name/phone/code, Enter opens), QR scan (`html5-qrcode`), `members.lookup` capability | P2 "R-05/R-06…", "MB-14…" |
| R-06 full history | ✅ | `services/members.ts#member360`, `/app/members/[id]` (memberships, bookings, social, visits, purchases, tabs, payments, dues, totals) | P2 "R-05/R-06…" |
| R-07 renew / upgrade / downgrade | ✅ | `renewMembership`, `upgradeMembership` (credit maths), `scheduleDowngrade`; staff + portal UIs | P2 "MB-6…", "MB-7…", "MB-8…" |
| R-08 courts per sport | ✅ | `services/courts.ts`; seed: 4 tennis + 2 cricket nets; padel/badminton via settings | P0/P3 world fixture |
| R-09 live availability | ✅ | `getAvailability` (staff names vs anonymised), command centre (10 s poll), `/availability`, portal booking | P3 "BK-12…" |
| R-10 staff book for anyone; members self-book | ✅ | `createBooking` channels FRONT_DESK/PHONE/MESSAGE/WALK_IN/ONLINE_MEMBER/ONLINE_TRIAL; booking dialog, portal | P3 RBAC tests |
| R-11 1-hour sessions on :00/:30 | ✅ | `assertValidSlot` (CT-3) | P3 "CT-3: 18:15 → INVALID_SLOT…" |
| R-12 max 2 plays/day | ✅ | `assertDailyLimit` + row locks (BK-3/BK-4), every member player, social counts | P3 "BK-4…" ×3, race "member with 1 play…" |
| R-13 member vs walk-in pricing | ✅ | `quoteCourt` per player by tier on the session date | P3 "Gold ₹0… Silver ₹150… walk-in ₹400…" |
| R-14 cancellations | ✅ | `cancelBooking` (BK-7 ≥ 2 h refund, late keeps dues), `changePlayers` (BK-8) | P3 "BK-7…" ×2, "BK-8…" |
| R-15 Friday social play | ✅ | `services/social.ts` (series, capacity lock, fees), `/app/courts/social`, `/portal/social` | P3 "SP-*", race "1 spot left…" |
| R-16 never the same court | ✅ | exclusion constraint `no_court_overlap` → `SLOT_TAKEN` | P3 "BK-1…", race "20 parallel…", `npm run demo:race` |
| R-17 catalogue | ✅ | `listCatalogue`, `/shop`, POS grid; 40 variants in the seed | P4 |
| R-18 live stock + low stock | ✅ | `inventory.ts` (available = on_hand − reserved, alerts SH-8, daily digest), `/app/shop/stock` | P4 "SH-8…" |
| R-19 fast counter sale | ✅ | `counterSale` (atomic, paid in full, split), `/app/shop` POS with keyboard search | P4 "SH-4…" |
| R-20 online ordering | ✅ | `checkout` (reservations, 15-min / 48-h holds), `/shop/cart` | P4 "SH-5…" |
| R-21 pickup | ✅ | READY_FOR_PICKUP → COLLECTED (payment required) | P4 "SH-6: pickup flow…" |
| R-22 delivery | ✅ | PACKED → OUT_FOR_DELIVERY → DELIVERED, undiscounted fee, notifications | P4 "SH-6: pay-at-pickup… delivery…" |
| R-23 one shared inventory | ✅ | single variant row for counter and online (SH-7) | P4 "SH-7…", shop race |
| R-24 member shop discount | ✅ | `quoteShop` (PR-5) | P4 "R-24/PR-5…" |
| R-25 fast order taking | ✅ | `/app/bar` tables map + one-tap item grid, batch add | P5 |
| R-26 item → who ordered; kitchen sees for whom | ✅ | tab lines belong to the tab's payer; KDS "Table 4 · Kiran" | P5 "BR-6…" |
| R-27 bar discount without asking | ✅ | `quoteBar` by payer tier (PR-6) | P5 "R-27/PR-6…" |
| R-28 tabs settled before leaving | ✅ | settle / partial settle / close / carry, open-tab guard on profile + close day | P5 "BR-8…", "BR-9…" |
| R-29 guests order and pay | ✅ | guest tabs, ID-verified alcohol rule | P5 "BR-5…" |
| R-30 cash / card / UPI | ✅ | counter payments, split, change, UPI QR (E-14) | P1, P5 "BR-8…" |
| R-31 table tracking | ✅ | `bar_tables`, OCCUPIED derived from open tabs | P5 "BR-2…" |
| R-32 staff shifts | ✅ | clock in/out with cash close (BR-10/E-15), roster | P5 "BR-10/E-15…", P7 "ST-2…" |
| R-33 daily bar revenue | ✅ | `barDayReport` / `closeBarDay` (by method, category, staff, discounts, voids) | P5 "BR-9… BR-11 report adds up" |
| R-34 public website | ✅ | `/`, `/facilities`, `/plans`, `/availability`, `/shop` | page checks (fork reports), e2e |
| R-35 trial online | ✅ | `createTrialBooking` (one per phone, all BK rules, lead) , `/trial` | P6 "CR-8…" ×2 |
| R-36 enquiries can't vanish | ✅ | leads never deleted (DB trigger), round-robin, notifications, overdue flags | P6 "R-36/CR-3…", "CR-4…" ×2 |
| R-37 follow-up, quote, convert | ✅ | activities, quotes + public page, "I'm interested", convert → WON on payment | P6 "CR-6…", "CR-7…" |
| R-38 earnings by source & method | ✅ | `reports.ts#computeDashboard` from the ledger | P8 "DB-3…" ×3 |
| R-39 what we owe / are owed | ✅ | payables (expenses + approved payroll + GST estimate), receivables | P8, P7 "EX-1…" |
| R-40 membership invoicing | ✅ | auto tax invoice on payment (IN-4), printable | P2 "MB-3/IN-4…", integrity #8 |
| R-41 business clients & invoices | ✅ | `invoices.ts` (GSTIN, FY numbering, IGST vs CGST/SGST, overdue) | P7 "IN-1…", "IN-2/IN-3…", "IN-2: OVERDUE…" |
| R-42 payroll | ✅ | `payroll.ts` (unpaid-leave deduction, owner approval, PAYROLL ledger) | P7 "ST-6…", "ST-7…" |
| R-43 leave approval | ✅ | `requestLeave` / `decideLeave` (allowance, unassigns shifts) | P7 "ST-4…", "ST-5…" |
| R-44 GST reporting support | ✅ | `gstReport` (by rate & category, CGST/SGST/IGST, input GST, unverified-rates warning) | P7 "IN-6…" |
| R-45 today / week / month | ✅ | period selector + previous-period change | P8 "DB-1…" ×2 |
| R-46 share the numbers | ✅ | CSV export, printable report, expiring/revocable `/share/[token]` | P8 "DB-5…" |
| R-47 staff schedules | ✅ | `/app/staff/roster` (week grid, exclusion constraint, leave conflicts, open shifts) | P7 "ST-2…", "ST-4…" |

## Enhancements

| ID | Priority | Status | Notes |
|---|---|---|---|
| E-01 pricing engine with explanations | P0 | ✅ | `pricing.ts`; every bill line stores its explanation |
| E-02 explainable rejections | P0 | ✅ | messages name courts, times, codes, members (BK-11) |
| E-03 DB double-booking guarantee + race script | P0 | ✅ | exclusion constraint, race tests, `npm run demo:race` |
| E-04 single ledger + invariants | P0 | ✅ | append-only trigger, integrity #6/#7 |
| E-05 court command centre | P0 | ✅ | `/app/courts` (10 s poll, colour-coded, dialogs) |
| E-06 Member 360 | P1 | ✅ | `/app/members/[id]` |
| E-07 QR card & check-in, visits, no-shows | P1 | ✅ | |
| E-08 tier booking window | P1 | ✅ | P3 "E-08…" |
| E-09 reservations + movement ledger + tracking | P0 | ✅ | `/orders/[token]`, portal orders |
| E-10 restring tickets | P1 | ✅ | P4 "SH-12/E-10…" |
| E-11 KDS + waiter queue | P0 | ✅ | `/app/bar/kds` (4 s poll), `/app/bar/ready` |
| E-12 junior alcohol block, guest ID flag | P0 | ✅ | P5 "E-12…" ×2, integrity #9 |
| E-13 open-tab guard | P1 | ✅ | profile banner, check-out warning, close-day block |
| E-14 split payments + UPI QR | P1 | ✅ | payment panel, settle dialog |
| E-15 cash-drawer reconciliation | P1 | ✅ | P5 "BR-10/E-15…" |
| E-16 notification centre (in-app + email outbox) | P0 | ✅ | dedupe keys; SMTP optional |
| E-17 CRM follow-up SLA | P1 | ✅ | overdue flag + job + board counter |
| E-18 dashboard with comparison and drill-down | P0 | ✅ | P8 |
| E-19 share links + CSV/PDF | P1 | ✅ | print CSS for PDF |
| E-20 audit trail viewer | P1 | ✅ | `/app/settings/audit` |
| E-21 GST-ready invoices | P1 | ✅ | `components/invoice-document.tsx` |
| E-22 recurring social template | P1 | ✅ | weekly series |
| E-23 idempotent operations | P0 | ✅ | P0/P1/P3 replay tests |
| E-24 waitlist | P2 | ⬜ | **Skipped** (P2 stretch) — no waitlist table or UI. |
| E-25 dev time travel + run jobs | P1 | ✅ | `/app/settings/dev` |

## §9 integrity and §10 checks

- `npm run verify:integrity` — checks #1–#10; the 60-day seed ends with 10/10 PASS (≈1,100 bookings, ≈200 counter sales,
  ≈500 bar tabs, 60 closed bar days, 2 payroll runs, invoices, leads).
- §10.2 concurrency: all four scenarios are Vitest tests; `npm run demo:race` runs the first one against the live app.
- §12 demo: `tests/e2e/demo.spec.ts` (Playwright).

## Known limitations (honest list)

- E-24 waitlist not built (P2).
- Live Razorpay could not be exercised without live keys; its paths (callback, FAIL confirmation, webhook, status
  check) are covered with mocked Razorpay responses, and online payment stays off until live keys are verified.
- i18n (translations, P2) was not built in the completion pass.
- UI screens were verified by role-gated HTTP checks (200/403 per role), API flows with the exact request shapes the
  screens send, and the Playwright demo (logins, sign-up form, member card, portal, KDS, availability, quote page,
  dashboard, 403 page in a real browser); not every dialog was clicked through manually.

## Completion pass ("real or absent" + every login complete)

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 Capabilities & payments | capability service + `/api/capabilities` (+ owner status), Test Gateway test-only, live-Razorpay hardening (webhook, status check before failing, FAIL confirmation), payment proof (UTR / approval code + last 4 / bank reference), cash drawers + daily reconciliation, pending refunds + pay-out, checkout fallbacks (pay at pickup / pay on delivery), GST categories (GOODS_5 / GOODS_18 / OUTSIDE_GST) and GSTIN check digit, KITCHEN role, `seed:demo` + `demo:reset`, passwords out of the code and README, APP_SECRET boot check | ✅ | typecheck ✓ · lint ✓ · 137/137 tests (11 new in `completion-phase1.test.ts`) · `seed:demo` 10/10 integrity · Playwright demo 11/11 |
| 2 First run & communication | empty identity + `create-owner` + `/setup` wizard gating `/app`; sample-data banner; email only when verified (test email in Settings), delivery/failure logged; WhatsApp `wa.me` links from booking/member/order/invoice/lead, logged as OPENED; Owner message log; seed advisory lock | ✅ | typecheck ✓ · lint ✓ · 145/145 tests (8 new in `completion-phase2.test.ts`) · `demo:reset` 10/10 integrity · Playwright demo 11/11 · `create-owner` checked on an empty DB (second Owner refused) |
| 3 Accounts & per-role checklists | login lockout + in-house rate limits, role landing pages, account page (details, last login, change password, log out everywhere) for staff and members, forgot password + staff-issued reset links, desk "Today", bar move item between tabs, KDS sound toggle, menu & price management, staff activity, expense bill uploads, nightly backups + Owner page, public consent/honeypot, robots/sitemap/product metadata, partners by mobile | ✅ | typecheck ✓ · lint ✓ · 158/158 tests (13 new in `completion-phase3.test.ts`) · `demo:reset` 10/10 integrity · Playwright demo 11/11 · a real backup (2.1 MB, PGDMP) taken through the service |
| 4 Carried-over fixes | click-through UI e2e in two payment set-ups; GST: alcohol outside GST, GSTR-1 (B2B/B2CS/HSN) + Tally CSV, GST page honest when GST is off, GOODS_5 default for sports goods; product photos (upload, category-icon fallback); facilities badge from maintenance; honest public copy; rate limits; docs | ✅ | typecheck ✓ · lint ✓ · 163/163 tests (5 new in `completion-phase4.test.ts`) · `demo:reset` 10/10 integrity · Playwright 27/27 (demo 11, ui-cash 8, ui-card-upi 8) · build with 0 warnings |
| 5 Extras (P1/P2) | P1: guardians + Portal → Family; DPDP (consent, privacy notice, data download, erasure requests + Owner decisions); purchase orders + stock take; 80 mm receipts; `.ics`; PWA. P2: barcodes at the till (scanner/camera), self check-in kiosk. Not built: i18n | ✅ (i18n ✗) | typecheck ✓ · lint ✓ · 169/169 tests (6 new in `completion-phase5.test.ts`) · `demo:reset` 10/10 integrity · Playwright 27/27 · build 0 warnings |
| 6 Audit & fresh install | `npm run audit:dummy` (source scan + crawl of every role × page on desktop and 360 px) → AUDIT.md; `fresh-install.spec.ts` (empty DB → create-owner → wizard → first member); fixes from both | ✅ | AUDIT.md: 0 source violations, 0 HTTP/console errors, 0 dummy text, 0 too-wide pages over 150 role × page combinations · typecheck ✓ · lint ✓ · 169/169 tests · 10/10 integrity · Playwright 32/32 (demo 11, ui-cash 8, ui-card-upi 8, fresh-install 5) |

Phase 1 notes:
- The live instance was rebuilt with `seed:demo` after a backup (`backups/pre-completion-pass-*.dump`, not in git):
  the old data contained Test-Gateway "online" payments, which are no longer real.
- Payment screens (payment panel, booking dialog, sign-up, POS, bar settle, social join, refunds, portal booking,
  social and cart checkout) render only enabled methods and ask for each method's proof; a `DRAWER_NOT_OPEN`
  rejection opens the drawer inline. New staff pages: `/app/drawer`, `/app/refunds`, `/app/finance/cash`,
  Settings → Payments & services.

## v3 — Operations upgrade, HTTPS and design port

### Definition of done (§12) — the 19 items

| # | Item | Phase / section | Main tests |
|---|---|---|---|
| 1 | Owner sees staff: directory | 3 · §4.1 | `v3-phase3-staff` directory; ui-flows 10 |
| 2 | Employee page | 3 · §4.2 | `v3-phase3-staff` employee page; ui-flows 10 |
| 3 | Attendance rules AT-1…AT-6 | 3 · §4.3 | `v3-phase3-staff` AT-1…AT-6; ui-flows 10 |
| 4 | Drawer shows all money collected | 4 · §5.1 | `v3-phase4-refunds` §5.1 |
| 5 | Refund workflow RF-1…RF-7 | 4 · §5.2 | `v3-phase4-refunds` RF-1…RF-7; ui-flows 11 |
| 6 | Sessions don't expire too early | 3 · §6.1 | `v3-phase3-staff` sessions; ui-flows 9 |
| 7 | Members list filters | 2 · §3/§6.2 | `v3-phase2-lists`; ui-flows 2b |
| 8 | Walk-in credentials WK-1…WK-7 | 5 · §6.4 | `v3-phase5-notifications` WK; ui-flows 2, 12 |
| 9 | Expiry and dues NT-1…NT-4 (on the §6.3 channels) | 5 · §6.3, §6.5 | `v3-phase5-notifications` NT, channels |
| 10 | Booking filters | 2, 6 · §7.1 | `v3-phase2-lists`, CC-8 |
| 11 | Club cancellation → reschedule or refund CC-1…CC-8 | 6 · §7.2 | `v3-phase6-closures-leads` CC; ui-flows 13 |
| 12 | Leads board filters | 2 · §8.1 | `v3-phase2-lists` leads |
| 13 | Lead assignment LA-1…LA-8 | 6 · §8.2 | `v3-phase6-closures-leads` LA |
| 14 | Leave date validation LV-1…LV-3 | 3 · §9.1 | `v3-phase3-staff` LV |
| 15–16 | Dynamic pricing PR-10…PR-15 | 7 · §9.2 | `v3-phase7-pricing-products` PR; ui-flows 14 |
| 17–19 | Product management (photos, prices/promotions, archive) | 7 · §9.3 | `v3-phase7-pricing-products` §9.3; ui-flows 15 |
| — | HTTPS | 1 · §1 | Path B: Let's Encrypt certificate on a fixed sslip.io/nip.io address, port 3443 (below); phone-camera check not done |
| — | Design port | 1, 8 · §2, §10 | contrast script; `docs/screenshots/before` and `after` |
| — | FilterBar on every list | 2, 8 · §3 | `v3-phase2-lists`, `v3-phase8-*` |

(The spec numbers §4 as "item 1"; items 2 and 3 are taken to be its employee page and attendance rules.)

### Phase 1 — HTTPS (§1) and design foundation (§2) ✅

**HTTPS findings (§1.1).** `ss -ltnp` shows ports 80 and 443 held by `caddy` (root, pid 3821258,
`/usr/local/bin/caddy run --config /etc/caddy/Caddyfile`, not a systemd unit). The Caddyfile serves other projects:
`38-49-215-124.nip.io` / `38.49.215.124.sslip.io` (CampusVerse, static), `http://38.49.215.124` and
`tourism.38.49.215.124.*` (→ 127.0.0.1:3100), `idr.38.49.215.124.*` (→ 127.0.0.1:8080). No nginx/Apache. → **Path B.**

**For the Caddy owner** — the block to add (then `caddy reload --config /etc/caddy/Caddyfile`); once it is live,
set `APP_URL=https://champions.38.49.215.124.sslip.io`, stop `champions-tunnel`, and bind the app to 127.0.0.1
(`-H 127.0.0.1` in `ecosystem.config.cjs`):

```
champions.38.49.215.124.nip.io, champions.38.49.215.124.sslip.io {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3200 {
		header_up Host {host}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-For {remote_host}
	}
	log {
		output file /var/log/caddy-champions.log {
			roll_size 10MiB
			roll_keep 3
		}
	}
}
```

**Now (2026-10-03): a fixed HTTPS address with a real certificate** — `https://champions.38-49-215-124.sslip.io:3443`
(also `https://champions.38-49-215-124.nip.io:3443`). PM2 `champions-https` (`scripts/https.mjs`) holds a Let's Encrypt
certificate for both names (issuer YE2, valid to 2027-01-01, renewed automatically 30 days before expiry, reloaded
without a restart). Ports 80/443 stay with the other project's Caddy, so the certificate uses the DNS-01 challenge:
sslip.io and nip.io delegate `_acme-challenge.<name>` to the IP inside the name, and the script answers those TXT
queries on 38.49.215.124:53 only while lego (`.bin/lego`, not in git) issues or renews. HTTPS is served on port 3443
and forwarded to the app on 127.0.0.1:3200 with `X-Forwarded-Proto: https`. Evidence: Let's Encrypt staging, then
production validated both names; `/login` → 200 from outside (fetched from the internet) with a verified chain;
`strict-transport-security: max-age=31536000`; `/manifest.webmanifest`, `/sw.js` served over HTTPS; plain HTTP to
the public name redirects to the HTTPS address (`tests/unit/https-redirect.test.ts`). The Cloudflare quick tunnel
(random addresses) is retired. Using port 443 without ":3443" still needs the Caddy owner's block above.
**Not verified here:** scanning a member card with a phone camera and installing the PWA on a phone.

| Item | Files | Tests / evidence |
|---|---|---|
| HTTPS with a Let's Encrypt certificate on a fixed address | `scripts/https.mjs`, `scripts/acme-hook.mjs`, `ecosystem.config.cjs`, `src/proxy.ts` | evidence above; `https-redirect` unit test |
| HTTP→HTTPS redirect, HSTS | `src/proxy.ts`, `next.config.ts` | curl evidence above; local `:3200` unaffected (e2e 32/32) |
| Design inventory | `DESIGN_PORT.md` | — |
| Tokens, fonts, contrast | `src/app/globals.css`, `src/app/layout.tsx`, `scripts/contrast.mjs` | `node scripts/contrast.mjs`: 22 pairs AA |
| Primitives restyled (props unchanged) | `src/components/ui/{button,badge,card,input,table,tabs,dialog}.tsx`, `page.tsx`, `states.tsx`, `logo.tsx`, staff header + sidebar, public nav + footer, portal header + tabs (fixed "CC" removed) | 169/169 tests · e2e 32/32 · integrity 10/10 · audit:dummy clean |
| Screenshots before | `docs/screenshots/before/` (50 images, 360 px + 1280 px) | `tests/audit/screenshots.spec.ts` |

### Phase 2 — FilterBar, summary strip and server filtering (§3), on Members, Bookings, Leads ✅

| Item | Files | Tests |
|---|---|---|
| List engine (search, IST date presets, facets with counts, sort, 25/50/100 paging, summary, defaults, CSV) | `src/server/services/filters/core.ts`, `index.ts`; `GET /api/lists/[name]`, `/api/lists/[name]/csv` | `v3-phase2-lists.test.ts` |
| Saved views (max 10 per list) | `src/server/services/saved-views.ts`, `/api/views`, migration `0006_v3_lists` (+ indexes for filtered columns) | `v3-phase2-lists.test.ts` › saved views |
| FilterBar, summary strip, chips, Clear all, N results, export, saved views, pager, day stepper | `src/components/list/{use-list.ts,filtered-list.tsx}`, `src/components/rel-time.tsx` | ui-flows step 2b |
| Members (tier, status incl. Expiring ≤7d, dues, open tab, Junior, guardian, joined, last visit, sport) + next action + row expand | `filters/members.ts`, `app/members/members-list.tsx` | members tests; ui-flows 2b |
| Bookings (date default Today, court, sport, status, channel, payment, member/guest, created by) + next action + detail in place | `filters/bookings.ts`, `app/courts/bookings/bookings-list.tsx` | bookings test; ui-flows step 4 |
| Leads (status, source, assignee incl. Me/Unassigned, overdue, created, interest); board and list share filters; front desk defaults to own open leads | `filters/leads.ts`, `app/crm/leads-board.tsx` | leads test; ui-flows 2b |

Checks: typecheck ✓ · lint ✓ · 175/175 tests · e2e 34/34 · integrity 10/10 · audit:dummy clean.

### Phase 3 — Sessions (§6.1), leave validation (§9.1), staff directory and attendance (§4) ✅

| Item | Files | Tests |
|---|---|---|
| Cause of early logouts found (D-62) | `DECISIONS.md` D-62 | — |
| Sliding sessions: member 30 d idle / 90 d absolute, staff 7 / 30, kiosk 90; extend when < half left, ≤ 1 write per 10 min; cookie = absolute end; revocation still immediate | `src/server/auth/sessions.ts`, migration `0007_v3_sessions_attendance` (sessions.kind, last_seen_at, absolute_expires_at), `POST /api/auth/kiosk`, kiosk page link | `v3-phase3-staff.test.ts` › sliding sessions (3) |
| 401 → `/login?returnTo=` (+ "Your session ended" when a session existed); API 401 → log-in-again dialog in place, data refetched, typed input kept | `src/proxy.ts` (x-cc-path), `src/server/auth/current.ts`, `src/components/{api.ts,session-guard.tsx}`, staff and portal layouts, login form | ui-flows step 9 |
| LV-1 `LEAVE_DATE_IN_PAST`, LV-2 `LEAVE_OVERLAP`, LV-3 approval re-validation + daily expiry → EXPIRED + notification | `src/server/services/staff.ts`, `src/server/jobs/index.ts`, `src/server/errors.ts`, leave form min dates, "Expired" filter | `v3-phase3-staff.test.ts` › LV-1, LV-2, LV-3 (×2) |
| Staff directory `/app/staff/employees` (now / clocked in since, today's shift, week worked vs scheduled, late this month, missing clock-outs, leave left, open drawer + expected cash); Owner, Manager, Accountant read-only | `filters/staff.ts` (employees), `app/staff/employees/*`, nav | directory test; ui-flows step 10 |
| Employee page: profile, attendance log, roster ±30 days, drawer sessions with variances, leave history and balance, payslips (Owner/Accountant), activity (Owner/Manager) | `staff.ts` `employeeDetail`, `GET /api/staff/employees/[id]`, `app/staff/employees/[id]/*` | employee page test; ui-flows step 10 |
| AT-1…AT-4 numbers in one SQL definition; settings `late_grace_minutes` 10, `overtime_threshold_minutes` 30, `missing_clockout_hours` 4 (Settings → Policies); missing clock-out job + Manager notification, never auto-closed | `src/server/services/attendance.ts`, `settings.ts`, `jobs/index.ts`, policies tab | AT-1/2/3, AT-4 tests |
| AT-5 correction with mandatory reason, originals kept, audited, "Edited" marker | `attendance.ts` `correctAttendance`, `POST /api/staff/attendance/[id]/correct`, `app/staff/_components/attendance-bits.tsx` | AT-5 test; ui-flows step 10 |
| AT-6 attendance log + per-employee summary for a period, FilterBar + CSV | `filters/staff.ts` (attendance, attendance-summary), `app/staff/attendance/*` | AT-6 test; ui-flows step 10 |
| Breaks | Not recorded anywhere in the system → no break column (absent, not zero); see D-65 | — |

Checks: typecheck ✓ · lint ✓ · 188/188 tests · e2e 38/38 · integrity 10/10 (11/11 once migration 0008 of phase 4 was applied) · audit:dummy clean (0 violations, every role crawled at desktop and 360 px).

### Phase 4 — Cash drawers (§5.1) and the refund workflow (§5.2) ✅

| Item | Files | Tests |
|---|---|---|
| Drawer shows collections by method (count, amount, refunds) + total collected; expected cash = float + cash − cash refunds; only cash is counted | `src/server/services/drawers.ts` (`drawerTotals`, `drawerPayments`), `src/components/drawer-breakdown.tsx`, `app/drawer/my-drawer.tsx` | §5.1 test; ui-flows step 8, 11 |
| Drill-down per method lists the payments; they sum exactly to the total | `GET /api/drawer/[id]/payments?method=` | §5.1 test (every method) |
| Online payments started at a counter count in that session | `payments.ts` `startOnlinePaymentTx` | §5.1 test |
| All sessions for Owner/Manager/Accountant with FilterBar (staff, date, variance ≠ 0) | `filters/drawers.ts`, `app/finance/drawers/*`, nav | §5.1 test |
| `refund_requests` table, states and codes (RF-…) | migration `0008_v3_refunds`, `src/server/services/{refund-records.ts,refunds.ts}` | `v3-phase4-refunds.test.ts` |
| RF-1 who may ask (staff on bills they can see; members for eligible items) | `refunds.ts` `requestRefund`, `requestRefundAsMember`, `POST /api/refunds/request`, request form on bills (`components/refund-request.tsx`, payment panel, booking detail) | RF-1 tests (staff, members) |
| RF-2 amount ≤ refundable (open requests count), partial, reason category + note | `refund-records.ts` `createRequestedTx` | RF-2 test |
| RF-3 policy refunds created approved; Manager ≤ `refund_manager_limit` (₹5,000), Owner above; never your own | `payments.ts` `refundTx` (policy request), `refunds.ts` `approveRefund`/`rejectRefund`, setting in Policies | RF-3 test |
| RF-4 back the way it came: gateway on approval (if online on), else desk with UTR / card reference / cash from an open drawer; FAILED → pay at the desk | `approveRefund`, `payOutRefund`, `retryAtDesk` | RF-4 tests (×2) |
| RF-5 completion = REFUND payment + negative ledger in one transaction + member notified | `refund-records.ts` `settleRequestIfPaid` | RF-5 test |
| RF-6 refunds queue with FilterBar + summary (Awaiting approval · Ready to pay out · Completed today ₹ · Failed); old refund endpoint and membership-cancel refund now open requests | `filters/refunds.ts`, `app/refunds/*`, `POST /api/payments/refund` | RF-6 test; ui-flows step 11 |
| RF-7 every transition audited; integrity stays green | audit actions `refund_request.*`; integrity check #11 | RF-7 test; `expectIntegrity` in every refund test |
| Member portal button for eligible refunds | API ready (`POST /api/refunds/request` as a member); the portal button comes with the club-cancellation choice in phase 6 | RF-1 (members) test |

Checks: typecheck ✓ · lint ✓ · 198/198 tests · e2e 40/40 · integrity 11/11 · audit:dummy clean.

### Phase 5 — Notification channels (§6.3), walk-in credentials (§6.4), expiry and dues (§6.5) ✅

| Item | Files | Tests |
|---|---|---|
| `notifyMember` fan-out with `notification_deliveries` (QUEUED/SENT/DELIVERED/FAILED/LINK_OPENED/SKIPPED), exactly once per key + channel | migration `0009_v3_notifications`, `src/server/services/channels.ts` | NT-4 channel tests |
| Web Push (`web-push`, `push_subscriptions`, dead subscriptions removed on 404/410), service worker push handler | `channels.ts`, `public/sw.js`, `POST /api/push/subscribe`, `/unsubscribe`, capability `push` | Web Push test |
| Email through the delivery log | `channels.ts` `flushDeliveries` | channel test; completion §3 tests |
| WhatsApp Cloud API (templates only, capability `whatsapp.api`, signed delivery webhook, test message) | `channels.ts`, `GET/POST /api/webhooks/whatsapp`, `POST /api/messages/test-whatsapp`, Settings → Payments & channels | WhatsApp API test |
| Manual WhatsApp "Messages to send" (open wa.me = LINK_OPENED, mark sent) | `POST /api/messages/manual/[id]/open|sent`, `app/messages/*`, nav | manual WhatsApp test |
| Member preferences (in-app always on) — portal and staff account | `GET/PUT /api/me/notifications`, `components/notification-settings.tsx` | preferences test; ui-flows step 12 |
| Notification log with facets type, channel, status, date, member, triggered by | `filters/notifications.ts` (notifications), `app/messages` | manual WhatsApp test |
| WK-1 no password fields; WK-2 login on first paid membership, username = phone (member code accepted), link valid `credential_link_hours` 72; Juniors under 13 with a guardian get none | `membership.ts` (`issueFirstCredentialsTx`), `auth/sessions.ts`, new-member form | WK-1/2/3 test, Junior test; ui-flows steps 2, 12 |
| WK-3 no plaintext password generated, stored or sent (hash only) | `createPasswordSetToken` | WK-1/2/3 test |
| WK-4 `MEMBERSHIP_WELCOME` on every available channel | `issueFirstCredentialsTx` | WK-4/5 test |
| WK-5 credentials panel: delivery status per channel, QR, Send on WhatsApp, 80 mm welcome slip | `components/credentials-panel.tsx`, `/print/welcome/[id]`, `GET /api/members/[id]/credentials` | WK-4/5 test; ui-flows step 2 |
| WK-6 reissue (old link invalid); WK-7 renewals send a confirmation only | `reissueCredentials`, `onMembershipBillPaid` | WK-6/7 test |
| NT-1 expiry reminders via the channels, once per membership + type + channel | `runMembershipJob` | NT-1 test; MB-11 |
| NT-2 dues reminders after `dues_reminder_days` (3), weekly, max 3, stop when paid | `src/server/services/dues.ts`, `dues_reminders`, daily job | NT-2 test |
| NT-3 Renewals & dues screen with FilterBar, how/when told, one-click WhatsApp, Renew now | `filters/notifications.ts` (renewals), `app/desk/expiring/*` | NT-1 test (list) |
| NT-4 exactly once per channel, preferences respected, unavailable = SKIPPED | `channels.ts` | NT-4 tests |
| Not verifiable on this server | Push and WhatsApp API need keys/accounts that aren't configured here (VAPID keys, a Meta WhatsApp Business account); both are absent in the UI until set, and work in tests with the transports mocked | — |

Checks: typecheck ✓ · lint ✓ · 209/209 tests · e2e 40/41 on the first run (step 11 in the card/UPI project: the refund confirmation vanished when the refundable amount reached ₹0 — a real UI bug, fixed in phase 6 and re-run there) · integrity 11/11 · audit:dummy clean. Push is configured on this server (VAPID keys generated into `.env`); a phone opt-in has not been tried.

### Phase 6 — Club cancellations (§7.2) and lead assignment (§8.2) ✅

| Item | Files | Tests |
|---|---|---|
| CC-1 "Close courts" (courts, date, range, reason, note) with a preview of every booking and social player and what they paid | `src/server/services/closures.ts` (`previewClosure`), `POST /api/closures/preview`, `app/courts/_components/close-courts-dialog.tsx` | CC-1/2/3/7 test; ui-flows step 13 |
| CC-2 one transaction: CANCELLED_BY_CLUB, reservations released, MAINTENANCE blocks (gaps only), daily counts freed, PENDING_CHOICE records; social sessions cancelled and refunded | `closeCourts`, migration `0010_v3_closures_leads`, `social.ts` `cancelSocialSessionTx`, every cancelled-status check updated | CC-1/2/3/7 and CC-2 tests |
| CC-3 booker and member players notified on every channel with reason, slot and the two choices; guests with a phone get a manual WhatsApp task | `notifyCancelled`, `channels.ts` `queueGuestWhatsApp`, migration `0011_v3_guest_messages` | CC-1/2/3/7 test |
| CC-4 reschedule once within `reschedule_window_days` (14), all BK rules, no extra charge (priced then waived), no partial refund | `rescheduleClubCancellation`, `booking.ts` `createBookingTx({ reschedule })`, `components/club-cancellation-choice.tsx` (portal + desk) | CC-4 test; ui-flows step 13 |
| CC-5 refund = approved CLUB_CANCELLATION request, full amount, ignoring the 2-hour rule; portal refund resolves the same record | `refundClubCancellation`, `refunds.ts` | CC-5 test |
| CC-6 auto-refund after `resolution_deadline_days` (7) | daily job `autoRefundClubCancellations` | CC-6 test |
| CC-7 unpaid: cancelled, nothing owed, notified | `closeCourts` | CC-1/2/3/7 test |
| CC-8 dashboard tile + bookings facet "Club cancellation: pending choice" | `reports.ts`, dashboard, `filters/bookings.ts` | CC-1/2/3/7 test |
| A regular booking can't be made inside the closed range | MAINTENANCE reservations + exclusion constraint | CC-1/2/3/7 test |
| LA-1…LA-4 deterministic assignment with tie-breaks | `crm.ts` `chooseAssignee` | LA-2, LA-1, LA-3/4 tests |
| LA-5 assigned at creation, assignee told in-app + push | `createLeadTx`, `notifyMember(channels: ["PUSH"])` | LA-5/6 test |
| LA-6 `assignment_reason` stored and shown | migration 0010, lead detail | LA tests |
| LA-7 Manager/Owner reassign with a reason, both told; deactivation reassigns | `assignLead`, `reassignLeadsOf`, `users.ts` | LA-7 test |
| LA-8 escalate once after `lead_escalation_hours` (48) | `flagOverdueLeads` | LA-8 test |

### Phase 7 — Dynamic pricing (§9.2) and product management (§9.3) ✅

| Item | Files | Tests |
|---|---|---|
| Price book page (base court/social fees per tier and sport, bar & café prices, bands, special dates, promotions, approvals, guardrails, simulator) | `app/pricing/*`, `src/server/services/price-book.ts`, `/api/pricing/*`, nav | PR tests; ui-flows step 14 |
| Base prices as dated versions; court/social fees moved from plan rows (migration) | migration `0012_v3_pricing_products`, `pricing.ts` `bookPrice`, `plans.ts`, `settings.ts` (walk-in), `shop.ts`/`bar.ts` price edits | existing pricing tests; PR-12 test |
| Time bands (+ PRICE_BAND_OVERLAP), special dates, promotions | `price-book.ts` `createRule`/`changeRule`/`endRule`/`decideRule`, `pricing.ts` `adjustBase`/`bestDiscount` | PR-10 tests |
| PR-10 precedence + explanation | `quoteCourt`, `quoteSocial`, `quoteShop`, `quoteBar` | PR-10 tests; booking at peak test |
| PR-11 guardrails (`max_manager_discount_pct` 30, `max_staff_discount_pct` 15; Owner-only) | `needsApproval`, `decideRule`, `setGuardrails` | PR-11 test; staff promotion test |
| PR-12 effective datetime, versioned, audited, old bills unchanged | `setBasePrice` (+ job `applyDuePriceChanges`), `changeRule` | PR-12 test |
| PR-13 simulator | `simulatePrice`, `POST /api/pricing/simulate` | PR-13 test; ui-flows step 14 |
| PR-14 public prices | `publicPriceNotes`, `GET /api/pricing/public`, `components/price-notes.tsx` on Plans, Availability, Shop, portal Book | PR-10 band test; ui-flows step 14 |
| PR-15 seed creates no rules | (no rule in any seed) | "no rules" test; ui-flows step 14 |
| Products list with FilterBar | `filters/products.ts`, `app/shop/products/*` | archive test, promotion test |
| Photos: up to 5, sharp 1200/400, cover, reorder, remove | `src/server/services/products.ts`, `/api/shop/products/[id]/photos*`, product editor | photos test; ui-flows step 15 |
| Details, variants, restring flag, price via price book (managers) | `updateProductDetails`, `addVariant`, `updateVariant` | details test |
| Archive/restore, PRODUCT_HAS_RESERVATIONS | `archiveProduct`, `restoreProduct` | archive test |
| Inline product promotion (staff limit) | `addProductPromotion` | promotion test |
| Public shop updates immediately (gallery) | `listCatalogue` images, `/shop/[id]` | ui-flows step 15 |

### Phase 8 — FilterBar on every list (§3.2) and the page-by-page design port (§10)

Every list in §3.2 now runs on the one list engine (`src/server/services/filters/*`, registry `filters/index.ts`) and
the one `FilteredList` component: search, date presets, filters with counts, sort, 25/50/100, chips, CSV (roles that
may export), saved views, a clickable summary strip and the next action in the row.

| List (§3.2) | List def | Page | Tests |
|---|---|---|---|
| Members, bookings, leads | `members.ts`, `bookings.ts` (+ club-cancellation facet), `leads.ts` | phase 2 | `v3-phase2-lists` |
| Social sessions & participants | `social.ts`, `social-participants.ts` | `/app/courts/social` (board view), `/app/courts/social/players` | `v3-phase8-bar-courts-desk` |
| Visits / check-ins | `visits.ts` | `/app/desk/visits` | `v3-phase8-bar-courts-desk` |
| Notifications / message log | `notifications.ts`, `messages.ts` | `/app/messages`, `/app/settings/messages` | `v3-phase5-notifications`, `v3-phase8-admin` |
| Online orders | `orders.ts` | `/app/shop/orders` (board / list) | `v3-phase8-shop` |
| Counter sales | `sales.ts` | `/app/shop/sales` | `v3-phase8-shop` |
| Products & stock | `products.ts`, `stock.ts` (`?filter=low` kept) | `/app/shop/products`, `/app/shop/stock` | `v3-phase7-…`, `v3-phase8-shop` |
| Stock movements | `movements.ts` | `/app/shop/movements` | `v3-phase8-shop` |
| Purchase orders | `purchase-orders.ts` | `/app/shop/purchasing` | `v3-phase8-shop` |
| Stock takes | `stock-takes.ts` | `/app/shop/stock-take` | `v3-phase8-shop` |
| Tabs | `tabs.ts` | `/app/bar/tabs` | `v3-phase8-bar-courts-desk` |
| Bar days | `bar-days.ts` | `/app/bar/day` | `v3-phase8-bar-courts-desk` |
| Invoices | `invoices.ts` (`?status=`, `?clientId=` kept) | `/app/finance/invoices` | `v3-phase8-finance` |
| Business clients | `clients.ts` | `/app/finance/clients` | `v3-phase8-finance` |
| Expenses | `expenses.ts` (`?status=OVERDUE/UNPAID` kept) | `/app/finance/expenses` | `v3-phase8-finance` |
| Payroll runs | `payroll.ts` | `/app/finance/payroll` | `v3-phase8-finance` |
| Ledger (Tally export follows the filters) | `ledger.ts` | `/app/finance/ledger` | `v3-phase8-finance` |
| Refunds | `refunds.ts` | `/app/refunds` | `v3-phase4-refunds` |
| Attendance | `staff.ts` (attendance, summary, employees) | `/app/staff/attendance`, `/app/staff/employees` | `v3-phase3-staff` |
| Roster / shifts | `shifts.ts` | `/app/staff/roster` (List tab) | `v3-phase8-admin` |
| Leave requests | `leave.ts` | `/app/staff/leave` | `v3-phase8-admin` |
| Drawer sessions | `drawers.ts` | `/app/finance/drawers` | `v3-phase4-refunds` |
| Audit log | `audit.ts` | `/app/settings/audit` | `v3-phase8-admin` |
| Users | `users.ts` | Settings → Users & roles | `v3-phase8-admin` |
| Data requests | `data-requests.ts` | `/app/settings/privacy` | `v3-phase8-admin` |
| Renewals & dues, notifications | `notifications.ts` | `/app/desk/expiring`, `/app/messages` | `v3-phase5-notifications` |
| Payslips | no separate list (each payslip page is reached from its run) | — | — |

Design port (§10): the primitives were ported in phase 1, so every page already uses the reference look; this phase
replaced the remaining hard-coded Tailwind colours on the public site, portal, kiosk, kitchen display, member card,
courts grid and shared components with the theme tokens, and every new screen was built in the new design. The
contrast check (`node scripts/contrast.mjs`) now also covers the tinted chips and state colours (all AA).

Parts of the reference design not used: its dark theme (none exists in the reference), its multi-club switcher and
event/tournament pages (no such features here), its sample data, photos, demo PIN and copy (never copied — `DESIGN_PORT.md`).


### Owner follow-up requests (2026-10-03)

| Request | Done | Where | Tests |
|---|---|---|---|
| "Session expires after a few minutes; the same password stops working" | Cause: the test gate reset the live database. Gates now use their own DB (`champions_e2e`) and app (:3201); the live club is never reset. Session windows already exceed 2–3 days (members 30 d, staff 7 d, sliding) | gate script, D-81 | `v3-session-credentials` (3) |
| HTTPS for the camera and push | Fixed address https://champions.38-49-215-124.sslip.io:3443 with a Let's Encrypt certificate (also the nip.io name), renewed automatically; the random-address tunnel is retired | `scripts/https.mjs` | evidence in phase 1 above |
| Email + push + phone for cancellations, maintenance, dues, expiry, refunds | Every member event goes through `notifyMember` (in-app, email, push, WhatsApp API or the manual WhatsApp queue); maintenance over bookings takes the club-cancellation path; desk cancellations, reschedules, auto-refunds, refund requested/approved/rejected, invoice due/overdue added; guests get email too; the worker retries with backoff and logs failures | `channels.ts`, `closures.ts`, `booking.ts`, `social.ts`, `dues.ts`, `refunds.ts`, `worker.ts`, D-80 | `v3-notify-coverage` (10) |
| Shop staff: photos, details, prices, dynamic discounts | New capability `shop.pricing` (Owner, Manager, Shop staff) for shop product prices (through the price book) and product/category/shop-wide discounts (time bands, days, dates; staff limit, larger ones go to a manager); the public shop shows the offer price | `price-book.ts`, `products.ts`, `shop.ts`, product editor, D-79 | `v3-shop-staff-pricing` (7) |
| Each panel shows only that role's work, no repetition | One menu per role (`ROLE_NAV`), each screen once; each role's home leads with "Waiting for you" to-dos from the database; repeated dashboard tiles and quick links removed | `_nav.ts`, `todo.ts`, `/api/me/todo` | `v3-role-panels` (19) |

Not provided by any service here: WhatsApp Cloud API keys and an SMS gateway (phone messages wait in "Messages to send"
for staff to send from the club phone until the owner adds them).

### Phase 9 — full regression (2026-10-03) ✅
On a snapshot, against the separate test club (`champions_e2e`, :3201): lint ✓ · `tsc` ✓ · unit/integration **293/293** ·
production build ✓ · Playwright **48/48** (demo, ui-cash incl. steps 13–15, ui-card-upi, fresh-install) ·
`verify:integrity` **11/11** · `audit:dummy` clean (0 source violations, 0 HTTP errors, 0 console errors, 0 dummy text,
0 too-wide pages) · `docs/screenshots/after` **50** images (360 + 1280 px). Not verified here: scanning a card with a
phone camera and receiving push on a phone (needs a person with a phone on the HTTPS address).

## v4 — Role navigation, Cash Drawer v2, Refunds v2, Push + WhatsApp

The club runs cash only; card, UPI and online payment are unchanged and still work when switched on (D-109).
Decisions D-82…D-109. Migrations (additive): `0014_v4_cash_drawers`, `0015_v4_push_queue`, `0016_v4_whatsapp`,
`0017_v4_refunds` (no `0013`: the navigation needed no schema change). New rule IDs: RN-1…RN-6, CD-1…CD-8,
RF-8…RF-11, NT-5…NT-15, WA-10…WA-44 (WhatsApp), WA-50…WA-56 (sending queue).

### Definition of done (§7)

| # | Item | Phase / section | Main tests |
|---|---|---|---|
| 1 | All sections implemented and mapped to files and tests | 1–5 · §1–§5 | the tables below |
| 2 | All tests pass, including the new ones; `verify:integrity` all checks (13/13 — the spec's "12/12" did not count v3's #11, D-94); `audit:dummy` clean with the new navigation | 6 | Phase 6 below |
| 3 | Cash only, a full day: drawers open → payments increment → refunds paid out decrement → drops → close → reconciliation balances | 2, 3 · §2, §3 | `v4-cash-drawer` CD-1, CD-1/RF-9, PAY_OUT/PAY_IN/CASH_DROP, CD-5/CD-6, CD-7/CD-8, reconciliation, integrity #12–#13; `v4-refunds` RF-9; e2e `v4-drawer` 1, `v4-refunds` 2; `seed:demo` 60 days of tills, drops, deposits and closes → 13/13 (D-89) |
| 4 | WhatsApp keys present and templates approved: cancellation, reschedule and refund messages send automatically and their statuses follow the webhook. Keys absent: push, in-app, email and the manual queue | 4, 5 · §4, §5 | `v4-notifications` WA-50…WA-56; `v4-whatsapp` WA-14, WA-40…WA-42, the §5.2 emitter tests; e2e `v4-whatsapp` 1 (keys absent → Off). Meta is mocked in tests: no keys exist on this server |

### Phase 1 — Role navigation (§1)

| Item | Files | Tests |
|---|---|---|
| §1.1 exact sidebars (Owner 22, Manager 21, Front desk 16 items; Shop, Bar, Kitchen, Accountant unchanged) | `src/app/(staff)/app/_nav.ts`, staff `layout.tsx`, `_components/sidebar.tsx` (unchanged) | `v4-role-nav` §1.1 (exact lists, each item a real screen, unchanged menus); e2e `v4-nav` 4 |
| §1.2 Employees (Owner) | `src/app/(staff)/app/employees/*`, `src/server/services/users.ts` (`updateStaff`, `forceLogout`), `PATCH /api/users/[id]/employment`, `POST /api/users/[id]/logout`, `filters/users.ts` | `v4-nav-dashboards` Employees ×2 |
| §1.2 Check-in Risk (RN-6) | `src/server/services/checkin-risk.ts`, `/api/desk/risk`, `src/app/(staff)/app/desk/risk/*` | `v4-nav-dashboards` RN-6 ×2 |
| §1.2 Notifications (front desk) | `src/app/(staff)/app/notifications/page.tsx` | `v4-role-nav` (screen exists); e2e `v4-nav` |
| RN-1 / RN-2 page access + allow-list | `src/server/rbac/page-access.ts`, `src/server/auth/current.ts`, My Account link to `/app/staff/me` | `v4-role-nav` RN-1 ×5, RN-2; e2e `v4-nav` RN-1, RN-2 |
| RN-3 capability matrix | `src/server/rbac/permissions.ts`, `price-book.ts`, `products.ts`, `todo.ts`, `pricing/price-book.tsx`, shop product texts | `v4-role-nav` RN-3 ×2; `v3-phase7-pricing-products`, `v3-shop-staff-pricing`; ui-flows 14 |
| RN-4 Needs your approval | `src/server/services/approvals.ts`, `approval-links.ts`, `/api/approvals`, `/api/approvals/decide`, `_dashboard/approvals-panel.tsx`, `staff.ts` and `attendance.ts` notification links, `todo.ts` | `v4-nav-dashboards` RN-4 ×5; `v3-role-panels`; ui-flows 11; e2e `v4-nav` RN-4/RN-5 |
| RN-5 dashboards per role | `src/server/services/dashboards.ts`, `/api/dashboards/*`, `_dashboard/{owner-cash,manager-today,front-desk}.tsx`, `_dashboard/dashboard.tsx` (Refunds payable tile), `app/page.tsx`, header `DrawerBadge` | `v4-nav-dashboards` RN-5 ×3; e2e `v4-nav` RN-4/RN-5 |
| §1.4 `audit:dummy` crawls the navigation lists | `tests/audit/crawl.spec.ts`, `scripts/audit-dummy.ts`, `tests/audit/screenshots.spec.ts` | the audit itself (a sidebar that differs from its list is a problem) |

### Phase 2 — Cash Drawer v2 (§2)

| Item | Files | Tests |
|---|---|---|
| §2.1 model: tills, sessions v2, movements, safe, deposits | `prisma/migrations/0014_v4_cash_drawers/migration.sql`, `prisma/schema.prisma` (CashDrawer, DrawerMovement, SafeMovement, BankDeposit, session fields) | `v4-cash-drawer` "two staff can't share…", "legacy openDrawer…"; migration checked on a copy of the live data (13/13) |
| CD-1/CD-2 live balance, `DRAWER_NOT_OPEN` | `src/server/services/drawers.ts`, `payments.ts` (`recordPaymentTx`, `refundTx`, `completeRefund`), `components/drawer-badge.tsx`, `/api/drawer/balance` | `v4-cash-drawer` CD-1, CD-2, CD-1/RF-9 |
| CD-3/CD-4 tendered, change, `INSUFFICIENT_CHANGE` | `components/tender-fields.tsx` (CashTender, quick tenders), `payment-panel.tsx`, `pos.tsx`, `booking-dialog.tsx`, `new-member-form.tsx`, `payments.ts` | `v4-cash-drawer` CD-3/CD-4 |
| §2.3 open by denomination, tills, settings | `drawers.ts` (`openDrawer`, tills), `lib/cash.ts`, `components/cash-count.tsx`, `DrawerOpener`, `/api/drawer/tills*`, Settings `cash-tab.tsx`, `settings.ts` (`cash_denominations`, `blind_close`, `drawer_variance_tolerance`) | `v4-cash-drawer` CD-5/CD-6 (denomination checks), legacy open |
| PAY_IN / PAY_OUT (expense) / CASH_DROP | `drawers.ts`, `expenses.ts` (`payExpenseTx`), `/api/drawer/{pay-in,pay-out,drop}` | `v4-cash-drawer` "PAY_OUT creates an expense…" |
| §2.4 My Cash Drawer | `src/app/(staff)/app/drawer/*`, `filters/drawers.ts` (`my-drawer-movements`), `components/drawer-movements.tsx` | e2e `v4-drawer` 1 |
| CD-5…CD-8 close, variance approval, handover | `drawers.ts` (`closeDrawer`, reason, approve/reject, `listDrawerVarianceApprovals`), `/api/drawer/sessions/[id]/*`, `app/finance/drawers/[id]`, capability `cash.approve_variance` | `v4-cash-drawer` CD-5/CD-6, CD-7/CD-8 |
| §2.6 safe, bank deposits, reconciliation, Cash Drawers page | `drawers.ts` (safe, `recordBankDeposit`, `dailyCashReconciliation`, `drawersOverview`, `cashSummary`), `/api/finance/safe`, `/api/finance/drawers`, `app/finance/drawers/*`, `app/finance/cash/*`, `uploads.ts` (kind `deposit`) | `v4-cash-drawer` reconciliation, RN-5 cash summary, safe test |
| §2.7 integrity #12–#13 (13 checks, D-94) | `src/server/services/integrity.ts` | `v4-cash-drawer` "integrity #12 … #13 — 13 checks"; every existing `expectIntegrity()` |
| Accountant to-do: "Cash in the safe to bank" (D-95) | `src/server/services/todo.ts` | `v3-role-panels` (accountant keys) |
| Sample tills + 60-day cash routine | `prisma/seed/history.ts` | `v4-cash-drawer` "seed:demo — the sample tills" |

### Phase 3 — Refunds v2 (§3)

| Item | Files | Tests |
|---|---|---|
| RF-8 ready to collect + signed QR | `refund-records.ts` (`settleRequestIfPaid`, `notifyRefund`), `refund-qr.ts`, migration `0017_v4_refunds` | `v4-refunds` RF-8 ×3 |
| RF-9 desk pay-out (find/scan → photo + identity tick → pay from the drawer → 80 mm receipt) | `refunds.ts` (`payOutRefund`, `findCollectableRefunds`, `collectableRefund`, `refundReceipt`, `payOutRefundPayment`), `payments.ts` (`completeRefund` outer transaction), `app/(staff)/app/refunds/payout.tsx`, `refunds-queue.tsx`, `refunds/[id]/*`, `print/refund/[id]/page.tsx`, `components/refund-receipt.tsx`, `/api/refunds/collect`, `/api/refunds/[id]/{collect,pay-out,complete}` | `v4-refunds` RF-9 ×3; ui-flows 11; e2e `v4-refunds` 2 |
| RF-10 unclaimed: reminders, Refunds payable | `refunds.ts` (`runRefundReminders`, `refundsPayableSummary`), `jobs/index.ts`, `reports.ts`, `report-summary.tsx` | `v4-refunds` RF-10 ×2 |
| RF-11 partial refunds | `refund-records.ts` (`refundableNow`), `refunds.ts` (`requestRefundAsMember` amount, `refundableLeft`), `components/refund-request.tsx` | `v4-refunds` RF-11 |
| §3.2/§3.3 member requests, approvers told | `refunds.ts`, `refund-records.ts` (`createRequestedTx`, `notifyApprovers`) | `v4-refunds` §3.7; e2e `v4-refunds` 3 |
| §3.4 portal Refunds and Payments tabs, banner, guardians | `app/(member)/portal/refunds/*`, `portal/payments/*`, `portal/receipts/[billId]`, `portal/_components/refund-qr.tsx`, `refund-banner.tsx`, `portal-nav.tsx`, `portal-home.tsx`, `components/refund-timeline.tsx`, `/api/portal/refunds`, `/api/portal/payments`, `/api/refunds/[id]/token` | `v4-refunds` §3.7 (full history), §3.4 (guardian) |
| §3.5 front-desk Refunds page (tabs, FilterBar, summary strip) | `refunds-queue.tsx`, `refunds/page.tsx`, `filters/refunds.ts`, `filters/core.ts` (`summaryIgnores`), `list/filtered-list.tsx` (`summaryView`) | `v4-refunds` RF-10 (strip the same on every tab) |
| §3.6 refund messages with WhatsApp values | `refund-records.ts` `notifyRefund` | `v4-refunds` §3.6 |
| `/rq/<token>` collection page | `app/(public)/rq/[token]/page.tsx`, `publicRefundByToken`, `robots.ts` (disallow `/rq`) | `v4-refunds` RF-8 (`/rq`) |

### Phase 4 — Event catalogue and Web Push (§4)

| Item | Files | Tests |
|---|---|---|
| §4.1 event catalogue + dedupe | `src/server/services/channels.ts` (`EVENT_CATALOGUE`, `MEMBER_EVENTS`, `notifyMember`/`notifyGuest`) | `v4-notifications` NT-5 ×2 |
| Booking confirmed / player added / order ready / restring ready | `booking.ts`, `shop.ts` | NT-15 |
| Booking cancelled by the member: every channel (D-82) | `booking.ts` (`cancelBookingTx`) | `v3-notify-coverage` "a booking cancelled by the desk or by the member" |
| Session reminder 2 h, social reminder 2 h, choice reminders day 3/6 | `src/server/services/reminders.ts`, `src/server/jobs/index.ts` (5-minute batch) | NT-11, NT-12, NT-13, "the 5-minute batch…" |
| Staff events (lead assigned, refund awaiting approval, drawer variance, leave decided) | catalogue (in-app + push only), `staff.ts` (`decideLeave` → LEAVE_DECIDED) | NT-14 |
| Optional templates (welcome, expiring, dues) | `membership.ts`, `dues.ts` (`wa`) | `v3-phase5-notifications`, `v3-notify-coverage` |
| §4.2 capability, `npm run vapid:generate`, `.env.example` | `scripts/vapid-generate.mjs`, `package.json`, `.env.example`, `capabilities.ts` (unchanged: HTTPS APP_URL + both keys) | — |
| Payload, TTL, urgency | `channels.ts` (`pushPayload`, `flushDeliveries`) | NT-6 |
| Quiet hours 22:00–07:00 IST | `channels.ts` (`inQuietHours`, `quietHoursEnd`, `pushIsUrgent`, `pushNotBefore`, claim filter) | NT-7 |
| 404/410 removal, retries max 3 | `channels.ts` `flushDeliveries` | NT-8, NT-9 |
| Service worker `push` + `notificationclick` | `public/sw.js` | — (needs a real push service: phone check under "Needs the owner") |
| Opt-in card, device list with Remove, iPhone note, `/api/push/subscriptions` | `components/push-opt-in.tsx`, `components/notification-settings.tsx`, `src/app/api/push/subscriptions/route.ts`, `…/[id]/route.ts`, `(member)/portal/page.tsx`, `(staff)/app/account/page.tsx` | NT-10; e2e `v4-push` 1, 2, 4 |

### Phase 5 — WhatsApp automation (§5)

| Item | Files | Tests |
|---|---|---|
| §5.1 env + capability `whatsapp.api` (WA-14) | `src/server/services/capabilities.ts`, `whatsapp/config.ts`, `.env.example`, README | `v4-whatsapp` WA-14 |
| §5.1 Settings → WhatsApp: status, token check, mapping, Fetch templates, test message (WA-15…WA-19) | `whatsapp/setup.ts`, `/api/whatsapp/{status,token-check,templates,templates/fetch,test}`, `settings/_components/whatsapp-tab.tsx`, `settings-tabs.tsx`, `payments-tab.tsx`, `settings.ts` (`whatsapp_template_map`, `whatsapp_health`) | `v4-whatsapp` WA-14…WA-19, Owner only; e2e `v4-whatsapp` 1 |
| §5.1 opt-in (WA-30…WA-32) | migration `0016_v4_whatsapp`, `schema.prisma`, `membership.ts`, `crm.ts`, `components/whatsapp-opt-in.tsx`, trial/enquiry/new-member forms, `whatsapp/opt-in.ts`, `/api/whatsapp/opt-in`, `components/whatsapp-consent-card.tsx`, portal notifications page | `v4-whatsapp` WA-30, WA-31, WA-32; e2e `v4-whatsapp` 2, 3 |
| §5.2 templates doc, builders, sanitiser (WA-10) | `docs/whatsapp-templates.md`, `whatsapp/templates.ts` | unit `v4-whatsapp-templates` WA-10 |
| §5.2 emitters (`wa`) | `closures.ts`, `booking.ts`, `social.ts`, `(member)/portal/bookings/[ref]/page.tsx` | `v4-whatsapp` §5.2 emitters ×4 (incl. WA-50), WA-21 |
| §5.3 `/r/<token>` (WA-20…WA-24) | `signed-links.ts`, `whatsapp/resolution.ts`, `/api/r/[token]`, `(public)/r/[token]/{page,choice}.tsx`, `errors.ts` (`LINK_*`) | `v4-whatsapp` WA-20…WA-24; e2e `v4-whatsapp` 4, `v4-refunds` 2 |
| §5.4 step 3 client + error classification (WA-11…WA-13) | `whatsapp/client.ts` | unit WA-11, WA-12, WA-13; `v4-whatsapp` WA-14 (#190) |
| §5.4 queue: in the transaction, after commit, 30 s sweep, SKIP LOCKED, wamid → SENT, retries, permanent, rate-limit pause, fallback | `src/server/db.ts` (`afterCommit`, `settleAfterCommit`), `channels.ts` (`dispatchWhatsApp`, `sweepWhatsApp`, `whatsappFallback`, `channelPausedUntil`), `src/server/jobs/worker.ts` (every 30 s), migration `0015_v4_push_queue` | `v4-notifications` WA-50…WA-56 |
| §5.4 step 6 webhook (WA-40…WA-44) | `whatsapp/webhook.ts`, `/api/whatsapp/webhook`, `/api/webhooks/whatsapp` (alias), migration `0016_v4_whatsapp` (`wa_*` columns, `whatsapp_inbound`) | `v4-whatsapp` WA-40…WA-44; `v3-phase5-notifications` WhatsApp API test |
| §5.4 step 8 Message Log and Notification Log | `filters/messages.ts` (`whatsapp-log`: event/template/status/date, masked number, timeline, error, tries), `filters/index.ts`, `filters/notifications.ts`, `settings/messages/page.tsx`, `settings/messages/whatsapp/*`, `messages/messages-list.tsx` (`DeliveryTimeline`) | `v4-notifications` WA-53; e2e `v4-push` 3 |

### Lead items

| Item | Files | Tests |
|---|---|---|
| HTTPS on a fixed address (D-107) | `scripts/https.mjs`, `scripts/acme-hook.mjs`, `ecosystem.config.cjs`, `src/proxy.ts`, `.env.example` (`HTTPS_*`); `scripts/tunnel.mjs` removed | `tests/unit/https-redirect.test.ts` |
| Playwright project `v4` (D-108) | `playwright.config.ts`; `openDrawerUi` in `v4-refunds.spec.ts` and `v4-whatsapp.spec.ts` | the five `v4-*.spec.ts` files |
| Sample club keeps card (and UPI during its history); live club cash only (D-109) | `prisma/seed/base.ts` (unchanged) | demo spec, `ui-card-upi` |

### New tests

| File | Tests | Covers |
|---|---|---|
| `tests/unit/v4-role-nav.test.ts` | 22 | §1.1 lists, §1.2 screens, RN-1, RN-2, RN-3 |
| `tests/unit/v4-whatsapp-templates.test.ts` | 24 | WA-10 builders and sanitiser, WA-11 request, WA-12 classification, WA-13 numbers |
| `tests/unit/https-redirect.test.ts` | 3 | plain HTTP on the public name → 308; IP and localhost untouched |
| `tests/integration/v4-nav-dashboards.test.ts` | 12 | RN-4, RN-5, RN-6, Employees |
| `tests/integration/v4-cash-drawer.test.ts` | 13 | CD-1…CD-8, pay-in/out, drops, safe, reconciliation, integrity #12–#13, seed tills |
| `tests/integration/v4-refunds.test.ts` | 12 | RF-8…RF-11, member request → collected, guardian, §3.6 values |
| `tests/integration/v4-notifications.test.ts` | 20 | NT-5…NT-15, WA-50…WA-56 |
| `tests/integration/v4-whatsapp.test.ts` | 19 | WA-14…WA-19, WA-20…WA-24, WA-30…WA-32, WA-40…WA-44, emitters |
| `tests/e2e/v4-nav.spec.ts` | 4 | step 4 (sidebars), RN-1, RN-2, RN-4/RN-5 |
| `tests/e2e/v4-drawer.spec.ts` | 1 | step 1 (open with float → ₹550 cash → +₹550 → blind close) |
| `tests/e2e/v4-refunds.spec.ts` | 2 | step 2 (wet court → `/r` refund → desk pay-out → Collected), step 3 (member request → dashboard approval → Ready to collect) |
| `tests/e2e/v4-push.spec.ts` | 4 | opt-in card, device list, WhatsApp log, staff My Account |
| `tests/e2e/v4-whatsapp.spec.ts` | 4 | Settings → WhatsApp, opt-in ticks, portal toggle, `/r/<token>` |

Helper: `tests/helpers/drawer.ts` (`withFloat`). The e2e files run in the Playwright project `v4`, after `ui-card-upi`.

### Existing tests changed (the requirement changed; no assertion weakened)

| File | Change | Decision |
|---|---|---|
| `tests/unit/v3-role-panels.test.ts` | v4 menus; Manager to-do `[]`, leave read from the approvals list; accountant keys + `safeToBank` | D-83, D-86, D-95 |
| `tests/integration/v3-phase7-pricing-products.test.ts` | price book, simulator, variant prices by the Owner; Manager FORBIDDEN; PR-11 approvals by the Owner | D-85 |
| `tests/integration/v3-shop-staff-pricing.test.ts` | court band by the Owner; shop-staff discount approved by the Owner, Manager FORBIDDEN | D-85 |
| `tests/integration/phase1-pricing-payments.test.ts` | PY-4: float before the ₹500 tender; identity tick on pay-out | D-90, D-97 |
| `tests/integration/phase5-bar.test.ts` | BR-8, BR-10/E-15: bar float before change | D-90 |
| `tests/integration/completion-phase1.test.ts` | ₹200 in the desk drawer before a ₹150 cash refund | D-91 |
| `tests/integration/v3-phase6-closures-leads.test.ts` | CC-2: the closure's social refund waits at the desk (APPROVED, READY_TO_COLLECT, one PENDING payment) | D-91 |
| `tests/integration/v3-phase4-refunds.test.ts` | identity tick; RF-4 online: cash in the drawer first; RF-1 approvers' type; member request REQUESTED → approved; RF-7 one more transition | D-91, D-96, D-97, D-98 |
| `tests/integration/phase2-membership.test.ts` | MB-13: identity tick | D-97 |
| `tests/integration/v3-notify-coverage.test.ts` | member's own cancellation on every channel; READY_TO_COLLECT / COLLECTED events; identity tick | D-82, D-97, D-98 |
| `tests/integration/v3-phase5-notifications.test.ts` | WhatsApp API test on the v4 env names, template map, opt-in, after-commit send and webhook | D-103 |
| `tests/e2e/ui-flows.spec.ts` | steps 2b and 9 by the Manager; step 8 blind count; step 11 inline approval, identity tick, "Cash refunds"; step 14 by the Owner; `openDrawerUi` till + denominations | D-84, D-85, D-86, D-92, D-97 |
| `tests/e2e/fresh-install.spec.ts` | step 4: float by denomination | D-92 |
| `tests/audit/crawl.spec.ts`, `scripts/audit-dummy.ts`, `tests/audit/screenshots.spec.ts` | crawl each role's navigation list; sidebar check; desk screenshot set | D-84 |

### Phase 6 — full regression

On a snapshot, against the separate test club (`champions_e2e`, 127.0.0.1:3201) — never the live club: lint ✓ · `tsc` ✓ · unit/integration **418/418** · production build ✓ · Playwright **63/63** (demo, ui-cash, ui-card-upi, fresh-install, and the v4 steps: drawer, refunds, navigation, push, WhatsApp) · `verify:integrity` **13/13** · `audit:dummy` clean (0 source violations, 0 HTTP errors, 0 console errors, 0 dummy text, 0 too-wide pages, 0 sidebar mismatches) · `docs/screenshots/after` **54** images (360 + 1280 px). Found and fixed by the gate: the v4 drawer e2e looked for a slot beyond the member's booking window; two portal pages were too wide on a phone (long links in notification bodies, the payment totals).

### Needs the owner

- **WhatsApp:** the six `WHATSAPP_*` values in `.env` (README → WhatsApp), the webhook set in the Meta app, and the
  templates in `docs/whatsapp-templates.md` submitted and approved in WhatsApp Manager; then Settings → WhatsApp:
  Check access token, map the templates, Fetch templates, Send test message. Until then WhatsApp messages wait in
  Messages to Send.
- **Cash only:** switch the live club to cash only in Settings → Payments & services (Counter payments).
- **Email:** the email capability needs SMTP in `.env` and a test email sent by the Owner from Settings →
  Payments & services; until then nothing is promised by email.
- **On a phone:** scan a member card with the camera and turn on push alerts at
  https://champions.38-49-215-124.sslip.io:3443 (not verifiable without a person and a phone).
