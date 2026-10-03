import { route } from "@/server/http";
import { removePushDevice } from "@/server/services/channels";

// v4 §4.2: Notification settings → Remove a device (own devices only).
export const DELETE = route<{ id: string }>(async ({ actor, params }) => removePushDevice(actor, params.id));
