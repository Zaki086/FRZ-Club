#!/bin/bash
# Regenerate prisma/migrations/0001_init from schema.prisma (dev only, before the first deploy).
# app_now() must exist before the tables that use it as their created_at default.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=prisma/migrations/0001_init/migration.sql
{
  echo "-- Injectable clock for created_at defaults (see 0002 and DECISIONS.md D-04)."
  echo "CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz AS \$\$"
  echo "  SELECT coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now())"
  echo "\$\$ LANGUAGE sql STABLE;"
  echo
  npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
} > "$OUT"
echo "wrote $OUT"
