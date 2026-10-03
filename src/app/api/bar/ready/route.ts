import { route } from "@/server/http";
import { readyQueue } from "@/server/services/bar";

export const GET = route(async ({ actor }) => readyQueue(actor));
