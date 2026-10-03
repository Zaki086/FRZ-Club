import { route } from "@/server/http";
import { getSettingRows } from "@/server/services/settings";

export const GET = route(async ({ actor }) => getSettingRows(actor));
