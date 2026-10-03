import { ApiError } from "@/components/api";

export type Rejection = { code?: string; message: string } | null;

export function toRejection(e: unknown): { code?: string; message: string } {
  return e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) };
}
