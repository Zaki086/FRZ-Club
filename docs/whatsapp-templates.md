# WhatsApp message templates (Meta WhatsApp Cloud API)

The club sends automatic WhatsApp messages only with templates that Meta has approved. Create each template below in
**WhatsApp Manager → Message templates → Create template**, exactly as written here, then map it in the app under
**Settings → WhatsApp** (template name + language code `en`) and press **Fetch templates**. A message is sent
automatically only when its template is mapped **and APPROVED**, the member opted in to WhatsApp updates, and the
`whatsapp.api` capability is on (keys in `.env`, access token checked, test message sent). Otherwise the other channels
(in-app, push, email) still go out and the message waits in **Messages to send** for the front desk.

For every template:

- **Category:** Utility
- **Language:** English (`en`)
- **Variables:** `{{1}}`, `{{2}}`, … in the body, in the order listed. The app fills them in; every value is cleaned
  (no new lines, no tabs, never more than 4 spaces in a row) and cut to 60 characters, as Meta requires.
- **URL button (where listed):** type *Visit website*, URL type **Dynamic**, URL `https://<APP_URL host>/<suffix>` —
  for example, with `APP_URL=https://club.example.in` the button of `club_session_cancelled` is
  `https://club.example.in/r/{{1}}`. The app sends only the part that replaces `{{1}}` (a signed link token, a refund
  code or a booking code).
- Amounts are written after the `₹` sign in the template; the app sends the number only (e.g. `1,550`). Dates and times
  are Indian format and time zone (e.g. `Sat, 10 Oct 2026` and `6:00 pm`).

Meta asks for a sample value for each variable and for the dynamic part of a URL when you submit a template; the sample
values below are only for Meta's review.

## Required templates (cancellations, reschedules and refunds)

### `club_session_cancelled`

| | |
|---|---|
| Name | `club_session_cancelled` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, your {{2}} session at The Champions Club on {{3}} at {{4}} has been cancelled because {{5}}. Please choose to reschedule or take a full refund of ₹{{6}} by {{7}}.` |
| Button | URL, text **Choose option**, `https://<APP_URL host>/r/{{1}}` (`{{1}}` = the signed resolution token) |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Sport and court | Tennis (Court 2) |
| `{{3}}` | Date | Sat, 10 Oct 2026 |
| `{{4}}` | Start time | 6:00 pm |
| `{{5}}` | Reason | Wet court |
| `{{6}}` | Amount paid (rupees) | 800 |
| `{{7}}` | Choose by (deadline) | Sat, 17 Oct, 6:00 pm |
| Button `{{1}}` | Resolution token | R1.ckexample.abc123.sig |

### `booking_cancelled_refund`

| | |
|---|---|
| Name | `booking_cancelled_refund` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, your booking {{2}} on {{3}} at {{4}} is cancelled. Refund: {{5}}.` |
| Button | URL, text **View details**, `https://<APP_URL host>/portal/refunds?ref={{1}}` (`{{1}}` = refund code, or the booking code when nothing was refunded) |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Booking code (or social session) | BK-000123 |
| `{{3}}` | Date | Sat, 10 Oct 2026 |
| `{{4}}` | Start time | 6:00 pm |
| `{{5}}` | Refund outcome | ₹800 to collect at the front desk |
| Button `{{1}}` | Refund code | RF-000045 |

### `booking_rescheduled`

| | |
|---|---|
| Name | `booking_rescheduled` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, your session has been moved to {{2}} at {{3}} on {{4}}. No extra charge. Booking {{5}}.` |
| Button | URL, text **View booking**, `https://<APP_URL host>/portal/bookings/{{1}}` (`{{1}}` = new booking code) |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Court | Court 3 |
| `{{3}}` | Start time | 7:00 pm |
| `{{4}}` | Date | Mon, 12 Oct 2026 |
| `{{5}}` | New booking code | BK-000130 |
| Button `{{1}}` | New booking code | BK-000130 |

### `cancellation_choice_reminder`

| | |
|---|---|
| Name | `cancellation_choice_reminder` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, you still need to choose for your cancelled session on {{2}}. If you don't choose by {{3}}, you will get a full refund of ₹{{4}}.` |
| Button | URL, text **Choose option**, `https://<APP_URL host>/r/{{1}}` (`{{1}}` = the signed resolution token) |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Date of the cancelled session | Sat, 10 Oct 2026 |
| `{{3}}` | Choose by (deadline) | Sat, 17 Oct, 6:00 pm |
| `{{4}}` | Amount paid (rupees) | 800 |
| Button `{{1}}` | Resolution token | R1.ckexample.abc123.sig |

### `refund_ready_to_collect`

| | |
|---|---|
| Name | `refund_ready_to_collect` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, your refund of ₹{{2}} (ref {{3}}) is ready to collect at the front desk. Please bring your member card or show the QR from the link.` |
| Button | URL, text **Show QR**, `https://<APP_URL host>/rq/{{1}}` (`{{1}}` = the signed refund collection token) |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Amount (rupees) | 550 |
| `{{3}}` | Refund code | RF-000045 |
| Button `{{1}}` | Refund collection token | RF1.ckexample.sig |

### `refund_completed`

| | |
|---|---|
| Name | `refund_completed` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, you received a refund of ₹{{2}} in cash on {{3}} (ref {{4}}). Thank you.` |
| Button | — |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Amount (rupees) | 550 |
| `{{3}}` | Date paid out | Sun, 11 Oct 2026 |
| `{{4}}` | Refund code | RF-000045 |

### `refund_rejected`

| | |
|---|---|
| Name | `refund_rejected` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, your refund request {{2}} for ₹{{3}} was not approved. Reason: {{4}}. Contact the front desk for help.` |
| Button | — |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Refund code | RF-000046 |
| `{{3}}` | Amount (rupees) | 300 |
| `{{4}}` | Reason | The session was already played |

### `refund_unclaimed_reminder`

| | |
|---|---|
| Name | `refund_unclaimed_reminder` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, a refund of ₹{{2}} (ref {{3}}) is still waiting for you at the front desk.` |
| Button | URL, text **Show QR**, `https://<APP_URL host>/rq/{{1}}` (`{{1}}` = the signed refund collection token) |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Amount (rupees) | 550 |
| `{{3}}` | Refund code | RF-000045 |
| Button `{{1}}` | Refund collection token | RF1.ckexample.sig |

## Optional templates

Used when created, approved and mapped; until then these messages go out by in-app, push and email (and the desk's
manual queue).

### `membership_welcome`

| | |
|---|---|
| Name | `membership_welcome` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, welcome to The Champions Club. Your {{2}} membership (member code {{3}}) is active until {{4}}.` |
| Button | — |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Plan | Gold |
| `{{3}}` | Member code | CC-000210 |
| `{{4}}` | End date | Sat, 2 Jan 2027 |

The login (set-password) link is never sent in a WhatsApp template; it goes by the channels that already carry it.

### `membership_expiring`

| | |
|---|---|
| Name | `membership_expiring` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, your {{2}} membership at The Champions Club ends on {{3}}. Renew at the front desk or in the member portal to keep playing.` |
| Button | — |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Plan | Silver |
| `{{3}}` | End date | Sat, 10 Oct 2026 |

### `dues_reminder`

| | |
|---|---|
| Name | `dues_reminder` |
| Category | Utility |
| Language | English (`en`) |
| Body | `Hi {{1}}, you have ₹{{2}} due at The Champions Club for {{3}}. Please pay at the front desk on your next visit.` |
| Button | — |

| Variable | Meaning | Sample |
|---|---|---|
| `{{1}}` | First name | Asha |
| `{{2}}` | Amount due (rupees) | 1,200 |
| `{{3}}` | What it is for | Court booking BK-000123 |

## Connecting the app

1. In the Meta app dashboard (WhatsApp → Configuration) set the **callback URL** to `https://<APP_URL host>/api/whatsapp/webhook`
   and the **verify token** to the value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; subscribe to the **messages** field. Meta's
   check appears in Settings → WhatsApp as "Webhook verified".
2. Put the six `WHATSAPP_*` variables in the server's `.env` (see `.env.example`) and restart the app.
3. Settings → WhatsApp: **Check access token**, map the templates, **Fetch templates**, then **Send test message**
   (Meta's sample `hello_world`, language `en_US`, works in every account).
4. People are messaged automatically only after they ticked "Send me booking and refund updates on WhatsApp" (sign-up,
   trial and enquiry forms, or the member portal → Notifications). A reply of **STOP** turns WhatsApp off for that number;
   any other reply becomes a "replied on WhatsApp" task in Messages to send.
