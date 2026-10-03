// Uploads (completion pass §7 accountant bills, §9 product images): stored on the server disk under UPLOAD_DIR,
// at most 2 MB, type checked by the file's own signature (not its name), served through /api/uploads with the
// access rule of their kind: product images are public, expense bills need expenses.view.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { DomainError } from "../errors";
import type { Actor } from "../rbac/actor";
import { assertCan, can } from "../rbac/permissions";
import { audit } from "./audit";
import { assertCapability } from "./capabilities";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const UPLOAD_KINDS = ["product", "expense", "deposit"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

const TYPES: Record<string, { ext: string; sig: (b: Buffer) => boolean }> = {
  "image/png": { ext: "png", sig: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: "jpg", sig: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: "webp", sig: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  "application/pdf": { ext: "pdf", sig: (b) => b.subarray(0, 5).toString() === "%PDF-" },
};
const ALLOWED: Record<UploadKind, string[]> = {
  product: ["image/png", "image/jpeg", "image/webp"],
  expense: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
  // v4 §2.6: bank deposit slips (Owner, Manager, Accountant).
  deposit: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
};
const NAME_RE = /^[a-z0-9]{24}\.(png|jpg|webp|pdf)$/;

export const uploadDir = () => path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.UPLOAD_DIR ?? "uploads");

function detect(data: Buffer): string | null {
  for (const [type, t] of Object.entries(TYPES)) if (t.sig(data)) return type;
  return null;
}

export async function saveUpload(actor: Actor, kind: string, data: Buffer) {
  if (!(UPLOAD_KINDS as readonly string[]).includes(kind)) throw new DomainError("VALIDATION_FAILED", "Unknown upload kind.");
  const k = kind as UploadKind;
  assertCan(actor, k === "product" ? "shop.stock" : k === "deposit" ? "cash.reconcile" : "expenses.manage");
  await assertCapability("photos.upload");
  if (data.length === 0) throw new DomainError("VALIDATION_FAILED", "The file is empty.");
  if (data.length > MAX_UPLOAD_BYTES) throw new DomainError("VALIDATION_FAILED", `The file is ${(data.length / 1_048_576).toFixed(1)} MB; the limit is 2 MB.`);
  const type = detect(data);
  if (!type || !ALLOWED[k].includes(type)) {
    throw new DomainError("VALIDATION_FAILED", k === "product" ? "Upload a PNG, JPEG or WebP image." : `Upload a photo (PNG, JPEG, WebP) or a PDF of the ${k === "deposit" ? "deposit slip" : "bill"}.`);
  }
  const name = `${randomBytes(12).toString("hex")}.${TYPES[type].ext}`;
  const dir = path.join(uploadDir(), k);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(/* turbopackIgnore: true */ dir, name), data, { flag: "wx" });
  const url = `/api/uploads/${k}/${name}`;
  await audit(prisma, actor, "upload.create", "upload", url, { after: { kind: k, type, bytes: data.length } });
  return { url, type, bytes: data.length };
}

/** Read an upload, applying its kind's access rule. */
export async function readUpload(actor: Actor, kind: string, name: string): Promise<{ data: Buffer; type: string }> {
  if (!(UPLOAD_KINDS as readonly string[]).includes(kind) || !NAME_RE.test(name)) throw new DomainError("NOT_FOUND", "File was not found.");
  if (kind === "expense" && !can(actor, "expenses.view")) throw new DomainError("FORBIDDEN", "Not allowed: expense bills are for finance staff.");
  if (kind === "deposit" && !can(actor, "cash.reconcile")) throw new DomainError("FORBIDDEN", "Not allowed: deposit slips are for finance staff.");
  const p = path.join(uploadDir(), kind, name);
  if (!(await stat(p).catch(() => null))) throw new DomainError("NOT_FOUND", "File was not found.");
  const data = await readFile(p);
  return { data, type: detect(data) ?? "application/octet-stream" };
}
