// v5 §3.4: a bulk send's progress (queued email/push at ≤ 1 per second, manual WhatsApp tasks) and its summary.
import { route } from "@/server/http";
import { bulkProgress } from "@/server/services/messages/bulk";

export const GET = route<{ id: string }>(async ({ actor, params }) => bulkProgress(actor, params.id));
