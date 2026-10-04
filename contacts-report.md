# Contacts normalisation report (v5 §2.2)

Produced by `npm run contacts:normalise` (`scripts/contacts-normalise.ts`). Dry run by default (read-only transaction);
`--apply` writes the non-colliding changes with one audit row each (`contacts.normalise`) and creates the
case-insensitive email index once clean. Canonical forms (src/lib/validation/contact.ts): mobile and landline →
10 digits without +91/0 (e.g. `9811000001`); email → trimmed lower-case. Values are masked; records are named by
member code / lead code / role and the first characters of the row id. Nothing is ever merged or deleted.

<!-- section:champions_e2e -->
## Database `champions_e2e` — dry run, 4 Oct 2026, 4:34 am IST

| Column | Values | Already canonical | Would change | Invalid (left as is) | Erased (DPDP) |
|---|---|---|---|---|---|
| Member mobile — `members.phone` | 123 | 123 | 0 | 0 | 0 |
| Member email — `members.email` | 116 | 116 | 0 | 0 | 0 |
| Guardian mobile — `members.guardian_phone` | 19 | 19 | 0 | 0 | 0 |
| Emergency contact mobile — `members.emergency_contact_phone` | 116 | 116 | 0 | 0 | 0 |
| Login mobile (users) — `users.phone` | 132 | 132 | 0 | 0 | 0 |
| Login email (users) — `users.email` | 125 | 125 | 0 | 0 | 0 |
| Guest mobile — `guests.phone` | 39 | 39 | 0 | 0 | 0 |
| Guest email — `guests.email` | 37 | 37 | 0 | 0 | 0 |
| Lead mobile — `leads.phone` | 94 | 94 | 0 | 0 | 0 |
| Lead email — `leads.email` | 85 | 85 | 0 | 0 | 0 |
| Business client phone — `business_clients.contact_phone` | 0 | 0 | 0 | 0 | 0 |
| Business client email — `business_clients.contact_email` | 3 | 3 | 0 | 0 | 0 |

Club settings: no phone or email set yet.
Case-insensitive unique email index `users_email_lower_key`: absent — migration 0018 creates it on deploy (no clashing emails: nothing blocks it).

### Would change (0)

Nothing — every valid value is already in canonical form.

### Invalid values — left as they are, for staff to correct (0)

None.

### Duplicates in unique columns after normalisation — not merged, not deleted (0)

None.
<!-- /section:champions_e2e -->

<!-- section:champions -->
## Database `champions` — dry run, 4 Oct 2026, 4:34 am IST

| Column | Values | Already canonical | Would change | Invalid (left as is) | Erased (DPDP) |
|---|---|---|---|---|---|
| Member mobile — `members.phone` | 124 | 124 | 0 | 0 | 0 |
| Member email — `members.email` | 117 | 117 | 0 | 0 | 0 |
| Guardian mobile — `members.guardian_phone` | 18 | 18 | 0 | 0 | 0 |
| Emergency contact mobile — `members.emergency_contact_phone` | 116 | 114 | 1 | 1 | 0 |
| Login mobile (users) — `users.phone` | 133 | 133 | 0 | 0 | 0 |
| Login email (users) — `users.email` | 126 | 126 | 0 | 0 | 0 |
| Guest mobile — `guests.phone` | 26 | 26 | 0 | 0 | 0 |
| Guest email — `guests.email` | 25 | 24 | 1 | 0 | 0 |
| Lead mobile — `leads.phone` | 81 | 81 | 0 | 0 | 0 |
| Lead email — `leads.email` | 64 | 64 | 0 | 0 | 0 |
| Business client phone — `business_clients.contact_phone` | 0 | 0 | 0 | 0 | 0 |
| Business client email — `business_clients.contact_email` | 3 | 3 | 0 | 0 | 0 |

Club settings: no phone or email set yet.
Case-insensitive unique email index `users_email_lower_key`: absent — migration 0018 creates it on deploy (no clashing emails: nothing blocks it).

### Would change (2)

| Record | Column | Stored (masked) | Canonical (masked) |
|---|---|---|---|
| members CC-000128 (cmussllxb0) | emergency_contact_phone | 08•••••••77 | 81••••••77 |
| guests (gst_ee9935) | email | 8•••@GMAIL.COM | 8•••@gmail.com |

### Invalid values — left as they are, for staff to correct (1)

| Record | Column | Stored (masked) | Why |
|---|---|---|---|
| members CC-000124 (cmusskisd0) | emergency_contact_phone | 56••••••56 | not a valid 10-digit Indian mobile |

### Duplicates in unique columns after normalisation — not merged, not deleted (0)

None.
<!-- /section:champions -->
