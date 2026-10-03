import fs from "node:fs";
import path from "node:path";

/** Read TEST_DATABASE_URL from the environment or .env (never the dev database). */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const envFile = path.resolve(__dirname, "../../.env");
  if (fs.existsSync(envFile)) {
    const m = /^TEST_DATABASE_URL="?([^"\n]+)"?/m.exec(fs.readFileSync(envFile, "utf8"));
    if (m) return m[1];
  }
  return "postgresql://champions:champions@localhost:5442/champions_test?connection_limit=25&pool_timeout=30";
}
