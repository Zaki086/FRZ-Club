import { route } from "@/server/http";
import { publicCapabilities } from "@/server/services/capabilities";

export const GET = route(async () => publicCapabilities(), { auth: "optional" });
