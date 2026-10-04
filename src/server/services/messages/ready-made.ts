// v5 §3.1: the 18 ready-made templates (active by default, editable by the Owner). This file is the source of the
// rows that migration 0021_v5_message_templates inserts on the live club (idempotently, by `key`), and that
// `ensureReadyMadeTemplates()` inserts after a database reset (seed, tests). Writing rules: short, friendly, specific,
// the club name and a clear next step; WhatsApp uses *bold* for the key facts and stays under 700 characters.
// Club details always come from variables (Settings → Club details), never from this file. A line whose variables are
// all empty (e.g. no club phone yet, or no link for this record) is left out when the message is rendered.
import type { TemplateCategory, TemplateChannel, TemplateContext } from "./contract";
import type { AutoWhatsAppTemplate } from "./variables";

export type ReadyMadeTemplate = {
  key: string;
  name: string;
  context: TemplateContext;
  category: TemplateCategory;
  channels: TemplateChannel[];
  waTemplate: AutoWhatsAppTemplate | null;
  whatsappText: string;
  emailSubject: string;
  emailBody: string;
  pushTitle: string;
  pushBody: string;
};

const ALL: TemplateChannel[] = ["WHATSAPP", "EMAIL", "PUSH"];
const NO_PUSH: TemplateChannel[] = ["WHATSAPP", "EMAIL"];

export const READY_MADE_TEMPLATES: ReadyMadeTemplate[] = [
  {
    key: "membership_expiring",
    name: "Membership expiring soon",
    context: "MEMBER",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: "membership_expiring",
    whatsappText: `Hi {{member.first_name}}, your *{{membership.plan}}* membership at {{club.name}} ends on *{{membership.end_date}}*.

Renew before then to keep your member court rates and advance booking. Renew in the member portal: {{link}}
Or renew at the front desk on your next visit.

Questions? Call {{club.phone}}.`,
    emailSubject: "Your {{club.name}} membership ends on {{membership.end_date}}",
    emailBody: `Hi {{member.first_name}},

Your {{membership.plan}} membership (member code {{member.code}}) ends on {{membership.end_date}}.

Renew before then to keep your member court rates and advance booking without a break. You can renew in the member portal in a minute, or at the front desk on your next visit.

Questions? Call us on {{club.phone}}.

See you on court,
{{club.name}}`,
    pushTitle: "Membership ends {{membership.end_date}}",
    pushBody: "Renew your {{membership.plan}} membership to keep your member rates. Tap to renew.",
  },
  {
    key: "membership_expired",
    name: "Membership expired — renew",
    context: "MEMBER",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hi {{member.first_name}}, your *{{membership.plan}}* membership at {{club.name}} ended on *{{membership.end_date}}*.

Until you renew, courts and social play are charged at walk-in rates. Renew in a minute in the member portal: {{link}}
Or renew at the front desk on your next visit.

We'd love to have you back. Questions? Call {{club.phone}}.`,
    emailSubject: "Your {{club.name}} membership has ended — renew to keep member rates",
    emailBody: `Hi {{member.first_name}},

Your {{membership.plan}} membership (member code {{member.code}}) ended on {{membership.end_date}}.

Until you renew, court bookings and social play are charged at walk-in rates. Renewing takes a minute in the member portal, or at the front desk on your next visit — your member code stays the same.

Questions? Call us on {{club.phone}}.

We'd love to see you back on court,
{{club.name}}`,
    pushTitle: "Your membership has ended",
    pushBody: "Your {{membership.plan}} membership ended on {{membership.end_date}}. Tap to renew.",
  },
  {
    key: "dues_reminder",
    name: "Dues reminder",
    context: "MEMBER",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: "dues_reminder",
    whatsappText: `Hi {{member.first_name}}, a friendly reminder from {{club.name}}: *{{dues.amount}}* is due on your account (member code *{{member.code}}*).

Please pay at the front desk on your next visit. See what it's for: {{link}}

Already paid? Thank you, please ignore this message. Questions: {{club.phone}}`,
    emailSubject: "Amount due at {{club.name}}: {{dues.amount}}",
    emailBody: `Hi {{member.first_name}},

A friendly reminder: {{dues.amount}} is due on your account (member code {{member.code}}).

You can see each unpaid bill in the member portal, and pay at the front desk on your next visit.

Already paid? Thank you — please ignore this email. Questions? Call us on {{club.phone}}.

Thank you,
{{club.name}}`,
    pushTitle: "{{dues.amount}} due",
    pushBody: "You have {{dues.amount}} due at {{club.name}}. Pay at the front desk — tap for details.",
  },
  {
    key: "welcome_portal",
    name: "Welcome + portal login",
    context: "MEMBER",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: "membership_welcome",
    whatsappText: `Welcome to {{club.name}}, {{member.first_name}}!

Your member code is *{{member.code}}* and your plan is *{{membership.plan}}*, valid until *{{membership.end_date}}*.

Book courts, join social play and see your bills in the member portal: {{portal.url}}
Log in with your mobile number. First time? Use "Forgot password" on the login page to set one.

See you at the club!`,
    emailSubject: "Welcome to {{club.name}} — your member code is {{member.code}}",
    emailBody: `Hi {{member.first_name}},

Welcome to {{club.name}}! We're glad to have you.

Your member code: {{member.code}}
Your plan: {{membership.plan}}, valid until {{membership.end_date}}

In the member portal you can book courts, join social play, see your bills and manage your membership: {{portal.url}}

Log in with your mobile number. First time? Use "Forgot password" on the login page to set your password.

See you at the club,
{{club.name}}`,
    pushTitle: "Welcome to {{club.name}}",
    pushBody: "Your member code is {{member.code}}. Book your first court in the portal.",
  },
  {
    key: "booking_reminder",
    name: "Booking reminder",
    context: "BOOKING",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hi {{member.first_name}}, a reminder of your booking at {{club.name}}:

*{{booking.court}}*
*{{booking.date}}, {{booking.time}}*
Booking *{{booking.code}}*

Please check in at the front desk when you arrive. Need to change it? {{link}}
Or call us on {{club.phone}}.`,
    emailSubject: "Reminder: {{booking.court}} on {{booking.date}}, {{booking.time}}",
    emailBody: `Hi {{member.first_name}},

A reminder of your court booking at {{club.name}}:

Court: {{booking.court}}
When: {{booking.date}}, {{booking.time}}
Booking: {{booking.code}}

Please check in at the front desk when you arrive. Need to change or cancel? You can do it in the member portal, or call us on {{club.phone}}.

See you on court,
{{club.name}}`,
    pushTitle: "{{booking.court}} · {{booking.time}}",
    pushBody: "Your booking {{booking.code}} on {{booking.date}}. Check in at the front desk when you arrive.",
  },
  {
    key: "booking_cancelled",
    name: "Booking cancelled",
    context: "BOOKING",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hi {{member.first_name}}, your booking *{{booking.code}}* at {{club.name}} is *cancelled*:
{{booking.court}}, {{booking.date}}, {{booking.time}}

If you had paid, any refund due is shown in the member portal: {{link}}

Want to play another time? Book a new slot in the portal or call {{club.phone}}.`,
    emailSubject: "Booking {{booking.code}} cancelled",
    emailBody: `Hi {{member.first_name}},

Your booking {{booking.code}} at {{club.name}} has been cancelled:

Court: {{booking.court}}
When: {{booking.date}}, {{booking.time}}

If you had paid for it, any refund due is shown in the member portal.

Want to play another time? Book a new slot in the portal, or call us on {{club.phone}}.

{{club.name}}`,
    pushTitle: "Booking {{booking.code}} cancelled",
    pushBody: "{{booking.court}}, {{booking.date}} {{booking.time}} is cancelled. Tap for details.",
  },
  {
    key: "session_cancelled_by_club",
    name: "Session cancelled by club (choose reschedule/refund)",
    context: "BOOKING",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hi {{member.first_name}}, we're sorry — {{club.name}} had to cancel your session:
*{{booking.court}}, {{booking.date}}, {{booking.time}}* (booking *{{booking.code}}*).

Please choose what you'd like: *move it to another time* or *get a refund*. Choose here: {{link}}

Prefer to talk? Call {{club.phone}} and we'll sort it out for you.`,
    emailSubject: "We had to cancel your session on {{booking.date}} — reschedule or refund?",
    emailBody: `Hi {{member.first_name}},

We're sorry — we had to cancel your session at {{club.name}}:

Court: {{booking.court}}
When: {{booking.date}}, {{booking.time}}
Booking: {{booking.code}}

Please choose what you'd like: move it to another time at no extra cost, or get a refund. Choose with the button below.

Prefer to talk? Call us on {{club.phone}} and we'll sort it out for you.

With apologies,
{{club.name}}`,
    pushTitle: "Session cancelled by the club",
    pushBody: "{{booking.court}}, {{booking.date}} {{booking.time}}. Choose: reschedule or refund.",
  },
  {
    key: "reschedule_confirmed",
    name: "Reschedule confirmed",
    context: "BOOKING",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: "booking_rescheduled",
    whatsappText: `Hi {{member.first_name}}, your session at {{club.name}} is *moved*. Your new booking:

*{{booking.court}}*
*{{booking.date}}, {{booking.time}}*
Booking *{{booking.code}}*

It's in your bookings in the member portal: {{link}}
See you on court!`,
    emailSubject: "Rescheduled: {{booking.court}} on {{booking.date}}, {{booking.time}}",
    emailBody: `Hi {{member.first_name}},

Your session at {{club.name}} has been moved. Your new booking:

Court: {{booking.court}}
When: {{booking.date}}, {{booking.time}}
Booking: {{booking.code}}

Please check in at the front desk when you arrive. Questions? Call us on {{club.phone}}.

See you on court,
{{club.name}}`,
    pushTitle: "Rescheduled: {{booking.date}}",
    pushBody: "{{booking.court}}, {{booking.time}} · booking {{booking.code}}.",
  },
  {
    key: "refund_ready",
    name: "Refund ready to collect",
    context: "REFUND",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: "refund_ready_to_collect",
    whatsappText: `Hi {{member.first_name}}, your refund of *{{refund.amount}}* from {{club.name}} is *ready to collect* in cash at the front desk.
Refund ref: *{{refund.code}}*

Show this collection QR at the desk: {{link}}
Please bring a photo ID. Questions: {{club.phone}}`,
    emailSubject: "Your refund of {{refund.amount}} is ready to collect",
    emailBody: `Hi {{member.first_name}},

Your refund of {{refund.amount}} (ref {{refund.code}}) is ready to collect in cash at the {{club.name}} front desk.

Show the collection QR at the desk — open it with the button below — and please bring a photo ID.

Questions? Call us on {{club.phone}}.

{{club.name}}`,
    pushTitle: "Refund ready: {{refund.amount}}",
    pushBody: "Collect it in cash at the front desk (ref {{refund.code}}). Tap to show your QR.",
  },
  {
    key: "refund_collected",
    name: "Refund collected — receipt",
    context: "REFUND",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: "refund_completed",
    whatsappText: `Hi {{member.first_name}}, this confirms you collected your refund of *{{refund.amount}}* (ref *{{refund.code}}*) at {{club.name}}.

Your receipt: {{link}}

Thank you!`,
    emailSubject: "Refund receipt {{refund.code}}: {{refund.amount}} collected",
    emailBody: `Hi {{member.first_name}},

This confirms you collected your refund of {{refund.amount}} (ref {{refund.code}}) at the {{club.name}} front desk.

Your receipt is in the member portal. Questions? Call us on {{club.phone}}.

Thank you,
{{club.name}}`,
    pushTitle: "Refund collected: {{refund.amount}}",
    pushBody: "Ref {{refund.code}} — your receipt is in the member portal.",
  },
  {
    key: "order_ready",
    name: "Order ready for pickup",
    context: "ORDER",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hi {{member.first_name}}, good news — your order *{{order.code}}* is *ready for pickup* at the {{club.name}} shop.

Collect it at the front desk. Order details and anything to pay: {{link}}

Questions: {{club.phone}}`,
    emailSubject: "Your order {{order.code}} is ready for pickup",
    emailBody: `Hi {{member.first_name}},

Good news — your order {{order.code}} is ready for pickup at the {{club.name}} shop.

Collect it at the front desk on your next visit. The button below shows the order and anything still to pay.

Questions? Call us on {{club.phone}}.

{{club.name}}`,
    pushTitle: "Order {{order.code}} is ready",
    pushBody: "Collect it at the club shop (front desk).",
  },
  {
    key: "restring_ready",
    name: "Restring ready",
    context: "ORDER",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hi {{member.first_name}}, your racket is *restrung and ready* (ticket *{{order.code}}*).

Collect it from the {{club.name}} shop at the front desk. Questions: {{club.phone}}

Enjoy the fresh strings!`,
    emailSubject: "Your racket is ready — ticket {{order.code}}",
    emailBody: `Hi {{member.first_name}},

Your racket is restrung and ready to collect (ticket {{order.code}}).

Pick it up from the {{club.name}} shop at the front desk. Questions? Call us on {{club.phone}}.

Enjoy the fresh strings,
{{club.name}}`,
    pushTitle: "Your racket is ready",
    pushBody: "Restring {{order.code}} — collect it at the club shop.",
  },
  {
    key: "settle_tab",
    name: "Please settle your bar tab",
    context: "TAB",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hi {{member.first_name}}, your bar tab at {{club.name}} is *{{tab.total}}*.

Please settle it at the bar — before you leave today or on your next visit.
See your tab: {{link}}

Thank you!`,
    emailSubject: "Your bar tab at {{club.name}}: {{tab.total}}",
    emailBody: `Hi {{member.first_name}},

Your bar tab at {{club.name}} is {{tab.total}}.

Please settle it at the bar — before you leave today or on your next visit. You can see every item on your tab in the member portal.

Thank you,
{{club.name}}`,
    pushTitle: "Bar tab: {{tab.total}}",
    pushBody: "Please settle your tab at the bar. Tap to see it.",
  },
  {
    key: "trial_follow_up",
    name: "Trial follow-up",
    context: "LEAD",
    category: "TRANSACTIONAL",
    channels: NO_PUSH,
    waTemplate: null,
    whatsappText: `Hi {{lead.first_name}}, thank you for trying {{club.name}}! We hope you enjoyed your session.

As a member you get member court rates, booking further ahead and social play with other members. See the plans: {{link}}

Reply here or call *{{club.phone}}* and we'll help you choose the right plan.`,
    emailSubject: "Thanks for trying {{club.name}} — ready to join?",
    emailBody: `Hi {{lead.first_name}},

Thank you for trying {{club.name}} — we hope you enjoyed your session!

As a member you get member court rates, can book further ahead and join social play with other members. The plans and prices are a click away.

Reply to this email or call us on {{club.phone}} and we'll help you choose the right plan.

Hope to see you again soon,
{{club.name}}`,
    pushTitle: "",
    pushBody: "",
  },
  {
    key: "quote_follow_up",
    name: "Quote follow-up",
    context: "LEAD",
    category: "TRANSACTIONAL",
    channels: NO_PUSH,
    waTemplate: null,
    whatsappText: `Hi {{lead.first_name}}, following up on your membership quote from {{club.name}}. You can see it here: {{link}}

Any questions about the plans or prices? Reply here or call *{{club.phone}}* — happy to help.`,
    emailSubject: "Your quote from {{club.name}}",
    emailBody: `Hi {{lead.first_name}},

Following up on the membership quote we sent you. You can open it with the button below.

Any questions about the plans or prices? Reply to this email or call us on {{club.phone}} — we're happy to help.

{{club.name}}`,
    pushTitle: "",
    pushBody: "",
  },
  {
    key: "invoice_due",
    name: "Invoice due reminder",
    context: "INVOICE",
    category: "TRANSACTIONAL",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hi {{member.first_name}}, a reminder that invoice *{{invoice.number}}* from {{club.name}} is due on *{{invoice.due_date}}*.

View the invoice: {{link}}

Already paid? Thank you, please ignore this message. Questions: {{club.phone}}`,
    emailSubject: "Invoice {{invoice.number}} is due on {{invoice.due_date}}",
    emailBody: `Hi {{member.first_name}},

A reminder that invoice {{invoice.number}} from {{club.name}} is due on {{invoice.due_date}}.

Already paid? Thank you — please ignore this email. Questions about the invoice? Call us on {{club.phone}}.

Thank you,
{{club.name}}`,
    pushTitle: "Invoice {{invoice.number}} due {{invoice.due_date}}",
    pushBody: "Tap to view the invoice from {{club.name}}.",
  },
  {
    key: "friday_social",
    name: "Friday social play invitation",
    context: "GENERAL",
    category: "ANNOUNCEMENT",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Hello from {{club.name}}!

You're invited to *Friday social play* this week — meet other members, get mixed into friendly games and stay for the evening. *All levels welcome.*

See the time and book your place: {{link}}
Questions? Call {{club.phone}}.`,
    emailSubject: "You're invited: Friday social play at {{club.name}}",
    emailBody: `Hello from {{club.name}}!

You're invited to Friday social play this week. Meet other members, get mixed into friendly games and stay on for the evening at the club. All levels are welcome.

See the start time and book your place with the button below — places are limited.

Questions? Call us on {{club.phone}}.

See you on Friday,
{{club.name}}`,
    pushTitle: "Friday social play",
    pushBody: "Join us this Friday at {{club.name}} — all levels welcome. Tap to book your place.",
  },
  {
    key: "club_notice",
    name: "Club notice (closure / timing change)",
    context: "GENERAL",
    category: "ANNOUNCEMENT",
    channels: ALL,
    waTemplate: null,
    whatsappText: `Notice from {{club.name}}:

*[[What is changing and when — e.g. Courts 1 and 2 are closed on Sunday 12 Oct, 6–10 am, for resurfacing]]*

We're sorry for any inconvenience. Questions? Call {{club.phone}}.`,
    emailSubject: "Notice from {{club.name}}: [[closure or new timings]]",
    emailBody: `Hello,

[[What is changing and when — e.g. Courts 1 and 2 are closed on Sunday 12 Oct, 6–10 am, for resurfacing. All other courts are open as usual.]]

We're sorry for any inconvenience. Questions? Call us on {{club.phone}}.

Thank you,
{{club.name}}`,
    pushTitle: "Notice from {{club.name}}",
    pushBody: "[[Closure or new timings, in one line]]",
  },
];
