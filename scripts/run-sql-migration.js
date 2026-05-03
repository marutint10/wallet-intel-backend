const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const migrationPath = process.argv[2];

  if (!migrationPath) {
    throw new Error('Usage: node scripts/run-sql-migration.js <migration.sql>');
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run database migrations');
  }

  const absoluteMigrationPath = path.resolve(process.cwd(), migrationPath);
  const sql = fs.readFileSync(absoluteMigrationPath, 'utf8');
  const useSsl = ['true', '1'].includes(
    String(process.env.DB_SSL ?? process.env.DATABASE_SSL ?? '').toLowerCase(),
  );
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`Applied migration: ${migrationPath}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});