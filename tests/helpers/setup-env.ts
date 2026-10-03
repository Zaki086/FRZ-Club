import { testDatabaseUrl } from "./env";

process.env.DATABASE_URL = testDatabaseUrl();
process.env.APP_SECRET ??= "test-secret-champions";
process.env.BCRYPT_ROUNDS ??= "4";
process.env.APP_URL ??= "http://localhost:3200";
process.env.TX_TIMEOUT_MS ??= "300000";
