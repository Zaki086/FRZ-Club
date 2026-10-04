// Runs once when the Next.js server boots (completion pass §5): refuse to start production with a weak secret.
// v6 URL-2: and with an APP_URL that isn't the club's real public https:// address (missing, plain http, a
// trycloudflare.com tunnel, localhost or a bare IP) — every link the club sends is built from it (URL-1).
import { assertPublicAppUrl } from "@/lib/url";

export async function register() {
  if (process.env.NODE_ENV !== "production") return;
  const s = process.env.APP_SECRET ?? "";
  const example = "change-me-to-a-long-random-string";
  if (s.length < 32 || s === example) {
    throw new Error("APP_SECRET must be set to a random value of at least 32 characters (and not the .env.example value) before starting in production.");
  }
  assertPublicAppUrl();
}
