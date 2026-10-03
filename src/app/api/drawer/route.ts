import { route } from "@/server/http";
import { myDrawer } from "@/server/services/drawers";

export const GET = route(async ({ actor }) => myDrawer(actor));
