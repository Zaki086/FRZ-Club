// v5 §3 — the MSGCORE ↔ MSGUI contract: request and response types of `/api/messages/*` (template library, composer,
// preview, send, bulk). Types and constants only, no server imports: client components import this file directly.
// Every response is wrapped by the route helper as `{ data: <type> }`; errors are `{ error: { code, message, details } }`.

// ───────── vocabulary ─────────

export const TEMPLATE_CONTEXTS = ["MEMBER", "BOOKING", "REFUND", "ORDER", "TAB", "LEAD", "INVOICE", "GENERAL"] as const;
export type TemplateContext = (typeof TEMPLATE_CONTEXTS)[number];
export const CONTEXT_LABEL: Record<TemplateContext, string> = {
  MEMBER: "Member", BOOKING: "Booking", REFUND: "Refund", ORDER: "Order", TAB: "Bar tab", LEAD: "Lead", INVOICE: "Invoice", GENERAL: "General",
};

export const TEMPLATE_CATEGORIES = ["TRANSACTIONAL", "ANNOUNCEMENT"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<TemplateCategory, string> = { TRANSACTIONAL: "Transactional", ANNOUNCEMENT: "Announcement" };

/** What a template can be sent on (and what the composer asks for). WhatsApp is by hand unless `autoWhatsApp`. */
export const TEMPLATE_CHANNELS = ["WHATSAPP", "EMAIL", "PUSH"] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];
export const CHANNEL_LABEL: Record<TemplateChannel, string> = { WHATSAPP: "WhatsApp", EMAIL: "Email", PUSH: "Push" };

/** The channel names of `notification_deliveries` rows (Message Log / Messages to Send). */
export type DeliveryChannel = "WHATSAPP_MANUAL" | "WHATSAPP_API" | "EMAIL" | "PUSH";
export type DeliveryStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "LINK_OPENED" | "SKIPPED";

/** Lists a bulk send can start from (§3.4). Recipients: members (members, renewals, checkin-risk) or leads. */
export const BULK_LISTS = ["members", "renewals", "checkin-risk", "leads"] as const;
export type BulkList = (typeof BULK_LISTS)[number];
/** "All N matching the filter" stops here. */
export const BULK_MAX = 500;
/** Duplicate guard: same template + same recipient within this window needs `confirmDuplicate: true`. */
export const DUPLICATE_WINDOW_HOURS = 24;
/** WhatsApp text limit for templates (characters). */
export const WHATSAPP_MAX_CHARS = 700;
/** A part of a template that staff must write before sending (e.g. the details of a club notice): `[[…]]`.
 *  Preview shows it; send and bulk refuse with VALIDATION_FAILED while one remains in the text being sent. */
export const FILL_IN_RE = /\[\[[^\]]*\]\]/;

/** Error codes the composer handles (all HTTP 409 unless noted). */
export const MESSAGE_ERRORS = {
  /** MT-1: a `{{variable}}` that the template's context does not have. details: { unknown: string[], context } */
  UNKNOWN_TEMPLATE_VARIABLE: "UNKNOWN_TEMPLATE_VARIABLE",
  /** Same template to the same recipient within 24 h. details: DuplicateDetails. Resend with confirmDuplicate: true. */
  DUPLICATE_RECENT_SEND: "DUPLICATE_RECENT_SEND",
  /** A channel that is not available or the recipient can't receive. details: { channel, reason } */
  CHANNEL_NOT_AVAILABLE: "CHANNEL_NOT_AVAILABLE",
  /** MT-4/MT-5: front desk sending an ANNOUNCEMENT, or a role that can't send messages (HTTP 403). */
  FORBIDDEN: "FORBIDDEN",
} as const;

// ───────── template content ─────────

export type TemplateContent = {
  whatsappText: string;
  emailSubject: string;
  /** Plain text with `{{variables}}`; blank lines separate paragraphs. Rendered into the club's HTML email layout. */
  emailBody: string;
  pushTitle: string;
  pushBody: string;
};
/** Text edited for one send only (the template itself is unchanged). Variables in overrides are rendered too. */
export type TemplateOverrides = Partial<TemplateContent>;

export type VariableInfo = { name: string; label: string; example: string };
/** GET /api/messages/variables → the variables each context may use (its own + club.* + portal.url + link). */
export type VariablesResponse = Record<TemplateContext, VariableInfo[]>;

// ───────── recipients and channels ─────────

export type Recipient = {
  kind: "MEMBER" | "GUEST" | "LEAD" | "CONTACT";
  /** member / guest / lead id (CONTACT: the business client id). */
  id: string;
  name: string;
  /** Masked ("+91 ••••••3210"), never the full number. */
  phone: string | null;
  /** Masked ("ra•••@gmail.com"). */
  email: string | null;
  /** Devices with push turned on. */
  pushDevices: number;
};

export type ChannelOption = {
  channel: TemplateChannel;
  /** Selectable: the channel works for the club AND this recipient can receive it AND the template supports it. */
  available: boolean;
  /** Why not (shown as a hint; the composer hides unavailable channels). */
  reason: string | null;
};

// ───────── GET /api/messages/templates?context=&recordId= (composer) ─────────

export type TemplatesQuery = { context: TemplateContext; recordId?: string };

export type ComposerTemplate = {
  id: string;
  /** Ready-made template key (e.g. "dues_reminder"), null for the Owner's own templates. */
  key: string | null;
  name: string;
  context: TemplateContext;
  category: TemplateCategory;
  version: number;
  /** Channels the template has text for. */
  channels: TemplateChannel[];
  /** Per channel: selectable for this recipient? (Without recordId: only the club-level availability.) */
  channelOptions: ChannelOption[];
  /** Shortcut: the selectable channels. */
  availableChannels: TemplateChannel[];
  /** "Send automatically on WhatsApp" may be offered (WhatsApp API on, approved Meta template mapped, opted in). */
  autoWhatsApp: boolean;
  /** Most relevant for this record (e.g. an unpaid booking → "Dues reminder"). Templates are sorted relevant first. */
  recommended: boolean;
  /** This actor's role may send it (ANNOUNCEMENT needs Manager/Owner — MT-4/MT-5). Not-allowed templates are omitted. */
  canSend: true;
  /** Sent to this recipient within 24 h (the send will need confirmDuplicate). */
  lastSentAt: string | null;
};

export type TemplatesResponse = {
  context: TemplateContext;
  recordId: string | null;
  /** Who the message goes to for this record (null without recordId). */
  recipient: Recipient | null;
  /** Context templates + GENERAL ones (+ MEMBER ones reachable through the record's member), most relevant first. */
  templates: ComposerTemplate[];
};

// ───────── POST /api/messages/preview ─────────

export type PreviewRequest =
  | { templateId: string; context: TemplateContext; recordId: string; channels?: TemplateChannel[]; overrides?: TemplateOverrides }
  /** MT-2 (Settings editor): preview unsaved text with a real record. */
  | { draft: TemplateInput; recordId: string };

export type RenderedMessage = {
  whatsapp?: { text: string; length: number; /** wa.me link (91 prefix, URL-encoded text), null without a mobile. */ waLink: string | null };
  email?: { subject: string; /** Plain-text alternative. */ text: string; /** Full HTML email (club layout). */ html: string };
  push?: { title: string; body: string };
};

export type PreviewResponse = {
  templateId: string | null;
  version: number | null;
  recipient: Recipient;
  /** The record's deep link that `{{link}}` became (absolute URL), or null. */
  link: string | null;
  rendered: RenderedMessage;
};

// ───────── POST /api/messages/send ─────────

export type SendRequest = {
  templateId: string;
  context: TemplateContext;
  recordId: string;
  channels: TemplateChannel[];
  overrides?: TemplateOverrides;
  confirmDuplicate?: boolean;
  /** Send WhatsApp through the Cloud API (only when the template's `autoWhatsApp` is true); otherwise wa.me by hand. */
  autoWhatsApp?: boolean;
};

export type SendResult = {
  channel: DeliveryChannel;
  /** WHATSAPP_MANUAL: QUEUED (open `waLink`, which records LINK_OPENED, then "Mark as sent"); EMAIL: SENT or FAILED;
   *  PUSH: one result per device, SENT or FAILED; WHATSAPP_API: QUEUED → sent right after (see the Message Log). */
  status: DeliveryStatus;
  deliveryId: string;
  /** WHATSAPP_MANUAL only: https://wa.me/91XXXXXXXXXX?text=<urlencoded>. Opening it should go through
   *  POST /api/messages/manual/<deliveryId>/open (records LINK_OPENED and returns the same url). */
  waLink?: string;
  /** PUSH: the device ("Chrome on Android"). */
  device?: string;
  error?: string | null;
};

export type SendResponse = { sendId: string; templateId: string; version: number; recipient: Recipient; results: SendResult[] };

/** `details` of DUPLICATE_RECENT_SEND. */
export type DuplicateDetails = {
  lastSentAt: string;
  sentBy: string | null;
  /** Bulk: the recipients that got it within 24 h. */
  recipients?: Array<{ name: string; lastSentAt: string }>;
};

// ───────── bulk (§3.4) ─────────

export type BulkRequest = {
  templateId: string;
  list: BulkList;
  /** Selected rows: member ids (members, renewals, checkin-risk) or lead ids (leads). */
  ids?: string[];
  /** Or "all matching the filter": the list's current query string as the list API returned it
   *  (e.g. "status=EXPIRING&tier=GOLD&q=raj"); checkin-risk: "scope=soon|today&kind=<RiskKind>". Max 500. */
  filter?: string;
  channels: TemplateChannel[];
  /** Text edited for this bulk send (same for everyone; variables still rendered per recipient). Needed for templates
   *  with a `[[fill-in]]` part (e.g. "Club notice"): sending is refused while a `[[…]]` remains. */
  overrides?: TemplateOverrides;
  confirmDuplicate?: boolean;
  autoWhatsApp?: boolean;
};

export type BulkSkip = { name: string; reason: string; /** Skipped on this channel only (else: the whole recipient). */ channel?: TemplateChannel };

/** POST /api/messages/bulk/preview (same body as BulkRequest): the first 3 recipients rendered, before confirming. */
export type BulkPreviewResponse = {
  total: number;
  /** Messages per channel that will go out. */
  perChannel: Record<TemplateChannel, number>;
  sample: Array<{ recipient: Recipient; channels: TemplateChannel[]; rendered: RenderedMessage }>;
  skipped: BulkSkip[];
  /** Recipients that got this template within 24 h (sending needs confirmDuplicate). */
  duplicates: Array<{ name: string; lastSentAt: string }>;
};

/** POST /api/messages/bulk */
export type BulkResponse = { bulkId: string; total: number; skipped: BulkSkip[] };

export type BulkStatus = "QUEUED" | "SENDING" | "DONE";
export type ChannelCounts = { total: number; queued: number; sent: number; failed: number; linkOpened: number };

/** GET /api/messages/bulk/[id] — progress while the worker sends (≤ 1 message/second), then the summary. */
export type BulkProgress = {
  id: string;
  status: BulkStatus;
  template: { id: string; name: string; version: number; category: TemplateCategory };
  list: BulkList;
  channels: TemplateChannel[];
  createdAt: string;
  createdBy: string | null;
  finishedAt: string | null;
  /** Recipients messaged on at least one channel. */
  total: number;
  /** Email + push + automatic WhatsApp (sent by the worker). */
  queued: ChannelCounts;
  perChannel: Partial<Record<DeliveryChannel, ChannelCounts>>;
  /** Manual WhatsApp: one task per recipient in Messages to Send. `nextId` drives "Send next"
   *  (POST /api/messages/manual/<id>/open, then /sent). */
  manual: { total: number; toSend: number; opened: number; sent: number; nextId: string | null };
  skipped: BulkSkip[];
  /** Seconds left for the queued messages at 1 per second. */
  etaSeconds: number;
};

/** GET /api/messages/bulk → the latest bulk sends (newest first). */
export type BulkListItem = Pick<BulkProgress, "id" | "status" | "template" | "list" | "channels" | "createdAt" | "createdBy" | "total" | "finishedAt">;

// ───────── template library (Settings → Message Templates) ─────────

export type TemplateInput = {
  name: string;
  context: TemplateContext;
  category: TemplateCategory;
  channels: TemplateChannel[];
  whatsappText: string;
  emailSubject: string;
  emailBody: string;
  pushTitle: string;
  pushBody: string;
  /** v4 §5 Meta template for "Send automatically on WhatsApp" (one of AUTO_WHATSAPP_TEMPLATES), or null. */
  waTemplate?: string | null;
  active?: boolean;
};

export type LibraryTemplate = TemplateContent & {
  id: string;
  key: string | null;
  name: string;
  context: TemplateContext;
  category: TemplateCategory;
  channels: TemplateChannel[];
  waTemplate: string | null;
  active: boolean;
  archivedAt: string | null;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  /** Times sent (all versions). */
  sends: number;
};

export type TemplateVersionInfo = TemplateContent & {
  version: number;
  name: string;
  category: TemplateCategory;
  channels: TemplateChannel[];
  waTemplate: string | null;
  createdAt: string;
  createdBy: string | null;
};

/** GET /api/messages/templates/library?archived=1 */
export type LibraryResponse = { templates: LibraryTemplate[]; canManage: boolean; autoWhatsAppTemplates: Array<{ name: string; context: TemplateContext; label: string }> };
/** GET /api/messages/templates/[id] */
export type TemplateDetail = LibraryTemplate & { versions: TemplateVersionInfo[] };

/** GET /api/messages/records?context=&q= — real records to preview with (MT-2) or to send to. */
export type RecordOption = { id: string; label: string; detail: string };

// ───────── API paths ─────────

export const MESSAGE_API = {
  templates: "/api/messages/templates",
  library: "/api/messages/templates/library",
  template: (id: string) => `/api/messages/templates/${id}`,
  archive: (id: string) => `/api/messages/templates/${id}/archive`,
  restore: (id: string) => `/api/messages/templates/${id}/restore`,
  variables: "/api/messages/variables",
  records: "/api/messages/records",
  preview: "/api/messages/preview",
  send: "/api/messages/send",
  bulk: "/api/messages/bulk",
  bulkPreview: "/api/messages/bulk/preview",
  bulkStatus: (id: string) => `/api/messages/bulk/${id}`,
  manualOpen: (deliveryId: string) => `/api/messages/manual/${deliveryId}/open`,
  manualSent: (deliveryId: string) => `/api/messages/manual/${deliveryId}/sent`,
} as const;
