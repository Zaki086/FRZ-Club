import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { DomainError } from "@/server/errors";
import { backupPath } from "@/server/services/backups";

/** Owner download of one backup file. */
export const GET = route<{ file: string }>(async ({ actor, params }) => {
  const p = backupPath(actor, params.file);
  const st = await stat(p).catch(() => null);
  if (!st) throw new DomainError("NOT_FOUND", "Backup was not found.");
  return new NextResponse(Readable.toWeb(createReadStream(p)) as ReadableStream, {
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(st.size), "Content-Disposition": `attachment; filename="${params.file}"` },
  });
});
