// Runs once when the Next.js server boots (completion pass §5): refuse to start production with a weak secret.
export async function register() {
  if (process.env.NODE_ENV !== "production") return;
  const s = process.env.APP_SECRET ?? "";
  const example = "change-me-to-a-long-random-string";
  if (s.length < 32 || s === example) {
    throw new Error("APP_SECRET must be set to a random value of at least 32 characters (and not the .env.example value) before starting in production.");
  }
}
