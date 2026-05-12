-- 202605060003_add_token_name_symbol.sql
--
-- Idempotently ensure token_name / token_symbol columns exist on token_analyses.
-- The original migration (202605060001_create_token_tables.sql) already creates
-- these columns, so this migration is a safety net for environments whose
-- token_analyses table predates them.
--
-- Schema target:
--   token_name   VARCHAR(128) NULL
--   token_symbol VARCHAR(32)  NULL

ALTER TABLE token_analyses
  ADD COLUMN IF NOT EXISTS token_name VARCHAR(128),
  ADD COLUMN IF NOT EXISTS token_symbol VARCHAR(32);

-- Older deployments may already have token_symbol as VARCHAR(16) (the original
-- create-table migration used 16). The ADD COLUMN IF NOT EXISTS line above is a
-- no-op in that case, so we additionally widen the column type idempotently.
-- ALTER COLUMN ... TYPE varchar(N) with N >= current size is a metadata-only
-- change in PostgreSQL.
ALTER TABLE token_analyses
  ALTER COLUMN token_symbol TYPE VARCHAR(32);
