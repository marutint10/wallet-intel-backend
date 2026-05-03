ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS chain_id VARCHAR(16) NOT NULL DEFAULT 'ethereum';

ALTER TABLE wallet_known_tokens
  ADD COLUMN IF NOT EXISTS chain_id VARCHAR(16) NOT NULL DEFAULT 'ethereum';

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS "UQ_transactions_wallet_address_transaction_hash";

ALTER TABLE wallet_known_tokens
  DROP CONSTRAINT IF EXISTS "UQ_wallet_known_tokens_wallet_address_contract_address";

ALTER TABLE transactions
  ADD CONSTRAINT "UQ_transactions_chain_wallet_hash"
  UNIQUE (chain_id, wallet_address, transaction_hash);

ALTER TABLE wallet_known_tokens
  ADD CONSTRAINT "UQ_wallet_known_tokens_chain_wallet_contract"
  UNIQUE (chain_id, wallet_address, contract_address);

CREATE INDEX IF NOT EXISTS "IDX_transactions_chain_wallet_address"
  ON transactions(chain_id, wallet_address);

CREATE INDEX IF NOT EXISTS "IDX_wallet_known_tokens_chain_wallet_address"
  ON wallet_known_tokens(chain_id, wallet_address);