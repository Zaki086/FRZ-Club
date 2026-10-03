import { route } from "@/server/http";
import { sendToKitchen } from "@/server/services/bar";

export const POST = route<{ id: string }>(async ({ actor, params }) => sendToKitchen(actor, params.id));
