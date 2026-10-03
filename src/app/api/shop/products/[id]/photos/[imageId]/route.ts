import { route } from "@/server/http";
import { removeProductPhoto } from "@/server/services/products";

export const DELETE = route<{ id: string; imageId: string }>(async ({ actor, params }) => removeProductPhoto(actor, params.id, params.imageId));
