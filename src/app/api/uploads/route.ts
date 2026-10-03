import { route } from "@/server/http";
import { DomainError } from "@/server/errors";
import { MAX_UPLOAD_BYTES, saveUpload } from "@/server/services/uploads";

/** multipart/form-data: kind = product | expense, file = the file (≤ 2 MB). */
export const POST = route(async ({ req, actor }) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) throw new DomainError("VALIDATION_FAILED", "The file is larger than 2 MB.");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) throw new DomainError("VALIDATION_FAILED", "Choose a file to upload.");
  return saveUpload(actor, String(form.get("kind") ?? ""), Buffer.from(await file.arrayBuffer()));
});
