CREATE TABLE IF NOT EXISTS token_deep_analyses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address  VARCHAR(64) NOT NULL,
  chain             VARCHAR(16) NOT NULL DEFAULT 'ethereum',
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  result            JSONB,
  error_message     TEXT,
  tavily_queries    JSONB,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(contract_address, chain)
);

CREATE INDEX IF NOT EXISTS idx_deep_analyses_addr
  ON token_deep_analyses(contract_address, chain);
