import { route } from "@/server/http";
import { restoreProduct } from "@/server/services/products";

export const POST = route<{ id: string }>(async ({ actor, params }) => restoreProduct(actor, params.id));
