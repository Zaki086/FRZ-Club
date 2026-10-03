-- Separate database for the Vitest suite (rules are tested on a real Postgres, never mocked).
CREATE DATABASE champions_test OWNER champions;
