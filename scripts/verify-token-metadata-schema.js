// Quick schema inspection: confirms token_name / token_symbol columns are
// present on token_analyses and reports current row count + any persisted
// (tokenName, tokenSymbol) pairs.
//
// Usage: node scripts/verify-token-metadata-schema.js
const { Client } = require('pg');
require('dotenv').config();

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const useSsl = ['true', '1'].includes(
    String(process.env.DB_SSL ?? process.env.DATABASE_SSL ?? '').toLowerCase(),
  );
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  try {
    const cols = await client.query(
      `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'token_analyses'
          AND column_name IN ('token_name', 'token_symbol')
        ORDER BY column_name`,
    );
    console.log('token_analyses metadata columns:');
    console.table(cols.rows);

    const sample = await client.query(
      `SELECT contract_address, chain, token_name, token_symbol, status, updated_at
         FROM token_analyses
        ORDER BY updated_at DESC
        LIMIT 10`,
    );
    console.log('Latest 10 rows:');
    console.table(sample.rows);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
