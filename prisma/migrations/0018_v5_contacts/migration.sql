-- v5 §2 (VALID) phone and email validation — CV-4: email uniqueness is case-insensitive where emails are unique
-- (users.email, which is also a login). Additive only.
--
-- The lower-case unique index is created only when no two users already share an email that differs just by case,
-- so this migration never fails on a live club's existing data. If it is skipped (NOTICE below):
--   1. `npm run contacts:normalise` (dry run) lists the clashing accounts in contacts-report.md;
--   2. staff resolve them by hand (nothing is merged or deleted automatically);
--   3. `npm run contacts:normalise -- --apply` lower-cases the stored emails and creates this index once it is clean.
DO $$
BEGIN
  IF to_regclass('public.users_email_lower_key') IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1) THEN
      CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
    ELSE
      RAISE NOTICE 'users_email_lower_key not created: some user emails differ only by case. Run npm run contacts:normalise.';
    END IF;
  END IF;
END $$;
