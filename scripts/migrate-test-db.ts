// `npm run db:migrate:test` — apply all migrations to the test database (the test run also does this first).
import setup from "../tests/helpers/global-setup";

setup();
console.log("Test database migrated.");
