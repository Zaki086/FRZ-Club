import { route } from "@/server/http";
import { archiveProduct } from "@/server/services/products";

export const POST = route<{ id: string }>(async ({ actor, params }) => archiveProduct(actor, params.id));
