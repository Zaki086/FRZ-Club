import { route } from "@/server/http";
import { deskToday } from "@/server/services/desk";

export const GET = route(async ({ actor }) => deskToday(actor));
