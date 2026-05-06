CREATE TABLE IF NOT EXISTS token_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address VARCHAR(64) NOT NULL,
  chain VARCHAR(16) NOT NULL,
  token_name VARCHAR(128),
  token_symbol VARCHAR(16),
  total_holders INTEGER,
  holders_data JSONB,
  quality_metrics JSONB,
  distribution JSONB,
  risk_callouts JSONB,
  status VARCHAR(16) DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_token_analyses_contract_chain
  ON token_analyses(contract_address, chain);

CREATE TABLE IF NOT EXISTS tracked_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address VARCHAR(64) NOT NULL,
  chain VARCHAR(16) NOT NULL,
  token_name VARCHAR(128),
  token_symbol VARCHAR(16),
  telegram_chat_id VARCHAR(64),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whale_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address VARCHAR(64) NOT NULL,
  wallet_address VARCHAR(64) NOT NULL,
  balance DECIMAL(36,18) NOT NULL,
  usd_value DECIMAL(18,2),
  snapshot_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whale_snapshots_contract_wallet_snapshot
  ON whale_snapshots(contract_address, wallet_address, snapshot_at);

CREATE TABLE IF NOT EXISTS whale_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address VARCHAR(64) NOT NULL,
  wallet_address VARCHAR(64) NOT NULL,
  alert_type VARCHAR(16) NOT NULL,
  old_balance DECIMAL(36,18),
  new_balance DECIMAL(36,18),
  delta_percent DECIMAL(8,4),
  usd_value_moved DECIMAL(18,2),
  triggered_at TIMESTAMP NOT NULL DEFAULT NOW(),
  delivered BOOLEAN DEFAULT false
);