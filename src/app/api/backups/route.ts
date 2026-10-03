import { route } from "@/server/http";
import { listBackups, runBackup } from "@/server/services/backups";

export const GET = route(async ({ actor }) => listBackups(actor));
export const POST = route(async ({ actor }) => runBackup("manual", actor));
