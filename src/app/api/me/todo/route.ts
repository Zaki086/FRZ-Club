import { route } from "@/server/http";
import { myTodo } from "@/server/services/todo";

export const GET = route(async ({ actor }) => myTodo(actor));
