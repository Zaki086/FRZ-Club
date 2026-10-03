# Design port — from `Frontend (2)/champions-club-development-main`

Only the **visual design** is taken from the reference. Routes, data flow, APIs, services and behaviour of the
app stay exactly as they are (v3 §2, §10).

## What the reference is

| Item | Found |
|---|---|
| Stack | TanStack Start (Vite) + React 19, Tailwind 4 (`@theme inline`), shadcn/ui on Radix, lucide icons, sonner |
| Theme file | `src/styles.css` — OKLCH tokens, "chalk cream + court green + optic yellow", **light only** (no dark palette) |
| Fonts | **Barlow Condensed** (display: headings, uppercase, tight leading) + **Manrope** (body) |
| Radius | `--radius: 0.875rem`; buttons fully rounded (pill), cards `rounded-2xl` |
| Shadows | `shadow-soft` (cards), `shadow-lift` (hover / sticky header), `bg-scrim` gradient for heroes |
| Utilities | `eyebrow` (tiny tracked uppercase label), `container-x` (max-w 80rem, 1.25 → 2 rem gutters), `animate-rise` |
| Components | `Logo` (accent disc + display wordmark), `StatusBadge` (dot + text chip, tones success/warning/destructive/muted/primary/accent), `PageHero`, `SectionHead`, `ProductCard`, pill buttons with `accent` and `ghostLight` variants, ink (`--ink`) header/sidebar with accent active state, tables with `bg-secondary` header and `rounded-2xl border` wrapper |
| Pages | public home, about, membership, booking, shop list/detail, café, events, contact, trial, register/login, member area (tabs on an ink band), a single-page "staff portal" |

## Tokens mapped into `src/app/globals.css`

`--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`, `--input`, `--primary`,
`--primary-foreground`, `--secondary`, `--accent` (optic yellow), `--accent-foreground`, `--destructive`,
`--success`, `--warning`, `--ink`, `--ink-foreground`, `--ring`, sidebar tokens, chart tokens, `--radius`,
`--shadow-soft`, `--shadow-lift`. Our existing names keep working: `--accent` used as a pale green highlight in
our screens is now `--secondary`/`--muted` where it was a background; tier colours (`--gold`, `--silver`,
`--junior`) and `--warning` text keep AA contrast on the cream background. Contrast of every new pair is checked by
`scripts/contrast.mjs` (WCAG AA 4.5:1 for text, 3:1 for large text / UI).

## Component mapping

| Reference | Ours (props unchanged) |
|---|---|
| `ui/button` pill, `accent`, `ghostLight` | `src/components/ui/button.tsx` (adds the two variants; `xl` size kept) |
| `ui/card` + `shadow-soft`, `rounded-2xl` | `src/components/ui/card.tsx` |
| `StatusBadge` (dot + text) | `src/components/ui/badge.tsx` tones re-coloured to the palette, dot added — colour is never the only signal |
| `ui/input`, `ui/textarea`, selects | `src/components/ui/input.tsx` |
| tables (`bg-secondary` head, rounded wrapper) | `src/components/ui/table.tsx` |
| dialog / tabs | `src/components/ui/dialog.tsx`, `tabs.tsx` |
| `SiteHeader` (ink bar, accent active link, pill CTA) + `SiteFooter` | `src/app/(public)/public-nav.tsx`, `(public)/layout.tsx` |
| `Logo` | `src/components/logo.tsx` (club initials from settings, not a fixed name) |
| member area ink band + tabs | `src/app/(member)/portal/portal-nav.tsx` |
| staff portal look (ink sidebar) | `src/app/(staff)/app/_components/sidebar.tsx`, staff header |
| `PageHero`, `SectionHead`, `eyebrow` | `src/components/page.tsx` (`PageHeader` keeps its props) |

## Never copied (would break "real or absent")

- `src/lib/data.ts` (fixed plans, courts, products, events, prices, "inr" helpers), `src/lib/store.tsx`
  (localStorage cart, members, bookings, orders) — our data comes from the services.
- `src/assets/*.jpg` stock photos (hero, courts, café, products) — product photos come from uploads, otherwise the
  category icon; heroes use colour and typography only.
- The staff portal's **demo PIN `1234`**, the fake login/register flows, the cart drawer state, toast-only actions.
- Copy text that promises things we may not have (events calendar, padel/badminton clubs, "Become a member"
  online) — our pages keep their own capability-driven text.
- `lovable-error-reporting`, the TanStack router and query setup, `bun` lockfile.

## Incompatible / not used

- Light theme only: the reference has no dark palette, so none is added.
- The reference's `ClubTabs` multi-club model (tennis/cricket/padel/badminton as separate "clubs") does not match
  our single club with courts per sport — layout pattern only.
- The `events` page has no counterpart (no events feature) — not ported.
- Fonts were loaded from Google's CDN in the reference; here they are self-hosted by `next/font` at build time.
