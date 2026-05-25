CREATE TABLE IF NOT EXISTS whitelisted_wallets (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  address     VARCHAR(42)  NOT NULL,
  plan        VARCHAR(16)  NOT NULL DEFAULT 'starter',
  note        TEXT,
  added_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,

  CONSTRAINT uq_whitelisted_wallets_address UNIQUE (address)
);

CREATE INDEX IF NOT EXISTS idx_whitelisted_wallets_address
  ON whitelisted_wallets (address);
