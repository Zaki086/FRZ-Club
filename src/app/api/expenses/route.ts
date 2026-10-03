import { z } from "zod";
import { body, query, route } from "@/server/http";
import { createExpense, expenseSchema, listExpenses } from "@/server/services/expenses";

export const GET = route(async ({ req, actor }) => listExpenses(actor, query(req, z.object({ status: z.string().optional(), category: z.string().optional() }))));

export const POST = route(async ({ req, actor }) => createExpense(actor, await body(req, expenseSchema)));
