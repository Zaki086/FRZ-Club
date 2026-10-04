import { route } from "@/server/http";
import { DomainError } from "@/server/errors";
import { removeMenuItemPhoto, setMenuItemPhoto } from "@/server/services/menu";
import { MAX_UPLOAD_BYTES } from "@/server/services/uploads";

/** multipart/form-data with `file` (PNG/JPEG/WebP ≤ 2 MB); resized on the server to 1200 px + a 400 px thumbnail. */
export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) throw new DomainError("VALIDATION_FAILED", "The file is larger than 2 MB.");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) throw new DomainError("VALIDATION_FAILED", "Choose a photo to upload.");
  return setMenuItemPhoto(actor, params.id, Buffer.from(await file.arrayBuffer()));
});

export const DELETE = route<{ id: string }>(async ({ actor, params }) => removeMenuItemPhoto(actor, params.id));
