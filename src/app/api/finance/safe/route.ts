import { body, route } from "@/server/http";
import { bankDepositSchema, recordBankDeposit, safeSummary } from "@/server/services/drawers";

// §2.6: the safe (cash drops in, pay-ins and bank deposits out) and bank deposits (Owner, Manager, Accountant).
export const GET = route(async ({ actor }) => safeSummary(actor));
export const POST = route(async ({ req, actor }) => recordBankDeposit(actor, await body(req, bankDepositSchema)));
