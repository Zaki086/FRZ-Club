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
