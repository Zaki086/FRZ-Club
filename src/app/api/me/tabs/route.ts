import { route } from "@/server/http";
import { myTabs } from "@/server/services/bar";

export const GET = route(async ({ actor }) => myTabs(actor));
