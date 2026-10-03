import bcrypt from "bcryptjs";

const ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 10);

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
