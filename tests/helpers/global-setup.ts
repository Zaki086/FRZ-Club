import { execSync } from "node:child_process";
import { testDatabaseUrl } from "./env";

export default function setup() {
  const url = testDatabaseUrl();
  if (!/_test\b/.test(url)) throw new Error(`Refusing to run tests against a non-test database: ${url}`);
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
}
