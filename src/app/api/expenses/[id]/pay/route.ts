import { body, route } from "@/server/http";
import { payExpense, payExpenseSchema } from "@/server/services/expenses";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => payExpense(actor, params.id, await body(req, payExpenseSchema)));
