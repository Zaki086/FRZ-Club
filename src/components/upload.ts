"use client";
// Upload a file (≤ 2 MB) to /api/uploads; the server checks the real file type. Returns the file's URL.
import { ApiError } from "./api";

export async function uploadFile(kind: "product" | "expense" | "deposit", file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024) throw new ApiError("VALIDATION_FAILED", `The file is ${(file.size / 1_048_576).toFixed(1)} MB; the limit is 2 MB.`, 422, null);
  const form = new FormData();
  form.set("kind", kind);
  form.set("file", file);
  let res: Response;
  try {
    res = await fetch("/api/uploads", { method: "POST", body: form });
  } catch {
    throw new ApiError("NETWORK", "Could not reach the server. Check the connection and try again.", 0, null);
  }
  const json = (await res.json().catch(() => ({}))) as { data?: { url: string }; error?: { code: string; message: string } };
  if (!res.ok || !json.data) throw new ApiError(json.error?.code ?? `HTTP_${res.status}`, json.error?.message ?? "Upload failed.", res.status, null);
  return json.data.url;
}
