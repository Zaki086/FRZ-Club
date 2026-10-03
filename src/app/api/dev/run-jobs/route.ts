import { route } from "@/server/http";
import { runJobsNow } from "@/server/services/devtools";

export const POST = route(async ({ actor }) => runJobsNow(actor));
