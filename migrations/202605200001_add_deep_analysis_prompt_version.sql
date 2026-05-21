ALTER TABLE token_deep_analyses
  ADD COLUMN IF NOT EXISTS prompt_version INT NOT NULL DEFAULT 1;
