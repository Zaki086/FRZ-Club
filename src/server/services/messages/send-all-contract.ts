// v6 §2.3 (SENDALL) "Send all": request/response types of `/api/messages/send-all/*`. Types and constants only, no
// server imports — client components import this file directly. Responses are wrapped as `{ data: <type> }`.
//
// SA-0: automatic WhatsApp goes out ONLY through the official WhatsApp Cloud API. The app never automates WhatsApp Web
// or Desktop, simulates clicks or uses unofficial libraries (that breaks WhatsApp's terms and gets the number banned).

export const SEND_ALL_API = {
  preflight: "/api/messages/send-all/preflight",
  start: "/api/messages/send-all",
  job: (id: string) => `/api/messages/send-all/${id}`,
} as const;

/** The Messages to Send filter (the list's query string as the FilterBar shows it) + "use other channels". */
export type SendAllRequest = {
  /** e.g. "type=DUES_REMINDER&q=raj" — channel/status/page/size/sort are ignored (always the queued manual tasks). */
  filter: string;
  /** "Use other channels when WhatsApp isn't possible" (default on): email / push instead. */
  useOtherChannels?: boolean;
};

export type ReasonCount = { reason: string; count: number };

export type SendAllSample = {
  whatsapp?: { to: string | null; template: string; params: string[]; text: string };
  email?: { to: string | null; subject: string; text: string };
  push?: { title: string; body: string };
};

/** POST /api/messages/send-all/preflight — computed on the server; nothing is sent or changed. */
export type SendAllPreflight = {
  filterKey: string;
  /** Queued manual WhatsApp tasks matching the filter. */
  total: number;
  /** SA-9: automatic WhatsApp is possible at all (capability `whatsapp.api`). */
  whatsappApi: { on: boolean; reason: string | null };
  /** "Send all", or "Send all by email & push" without the WhatsApp API (SA-9). */
  buttonLabel: string;
  /** Owner: link to Settings → WhatsApp; everyone else: null (they see "Ask the owner to finish WhatsApp setup"). */
  setupHref: string | null;
  useOtherChannels: boolean;
  /** Tasks that will be sent, per channel (a task can go by email and push). */
  willSend: { tasks: number; whatsapp: number; email: number; push: number };
  /** SA-1/SA-2/SA-3 (+ already reached by email/push): taken out of the queue when confirmed. */
  skipped: { total: number; notRelevant: number; duplicate: number; expired: number; reasons: ReasonCount[] };
  /** Stay in the queue: why each can't go automatically (a task may count under several reasons). */
  cannot: { total: number; reasons: ReasonCount[] };
  /** SA-10: front desk — announcements need a Manager or the Owner (left in the queue). */
  excludedAnnouncements: number;
  samples: SendAllSample;
  /** SA-8: a job already running for this filter (confirming again returns it). */
  runningJob: SendAllJob | null;
};

export type SendAllJobStatus = "QUEUED" | "RUNNING" | "DONE";

export type SendAllJob = {
  id: string;
  status: SendAllJobStatus;
  filter: string;
  useOtherChannels: boolean;
  whatsappApi: boolean;
  createdAt: string;
  createdBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Tasks the job sends. */
  total: number;
  sent: number;
  failed: number;
  /** Not sent after all (no longer relevant at send time, handled by someone else meanwhile). */
  skipped: number;
  /** Still to go (waiting includes WhatsApp retries / rate-limit pause and pushes held for the quiet hours). */
  remaining: number;
  waiting: number;
  /** WhatsApp sending paused by a rate limit until then (it resumes by itself). */
  pausedUntil: string | null;
  /** Delivery rows of this job per channel. */
  perChannel: Partial<Record<"WHATSAPP_API" | "EMAIL" | "PUSH", { sent: number; failed: number; queued: number }>>;
  /** Tasks that could not be sent (they stay in Messages to Send with this reason). */
  failures: Array<{ taskId: string; name: string; reason: string }>;
  /** What the preflight showed when it was confirmed. */
  preflight: { skipped: number; cannot: number; excludedAnnouncements: number };
};

/** POST /api/messages/send-all — `created: false` when a job was already running for the filter (SA-8). */
export type SendAllStartResponse = { job: SendAllJob; created: boolean };
