import { Client } from 'pg';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { WHITELISTED_WALLETS } from '../src/auth/whitelist';
import {
  getDatabaseSslOption,
  parseDatabaseSslEnv,
} from '../src/database/database-options';

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

async function syncWhitelist(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const sslOption = getDatabaseSslOption(databaseUrl, parseDatabaseSslEnv());

  const client = new Client({
    connectionString: databaseUrl,
    ssl: sslOption === false ? undefined : sslOption,
  });

  await client.connect();
  console.log(`\nSyncing ${WHITELISTED_WALLETS.length} wallet(s)...\n`);

  try {
    for (const wallet of WHITELISTED_WALLETS) {
      const address = wallet.address.toLowerCase();
      await client.query(
        `INSERT INTO whitelisted_wallets (address, plan, note)
         VALUES ($1, $2, $3)
         ON CONFLICT (address) DO UPDATE SET plan = $2, note = $3`,
        [address, wallet.plan, wallet.note ?? null],
      );
      console.log(`  ✓  ${address}  [${wallet.plan}]  — ${wallet.note}`);
    }

    const fileAddresses = WHITELISTED_WALLETS.map((w) =>
      w.address.toLowerCase(),
    );

    let removedCount = 0;
    if (fileAddresses.length > 0) {
      const placeholders = fileAddresses.map((_, i) => `$${i + 1}`).join(', ');
      const result = await client.query(
        `DELETE FROM whitelisted_wallets WHERE address NOT IN (${placeholders})`,
        fileAddresses,
      );
      removedCount = result.rowCount ?? 0;
    } else {
      const result = await client.query('DELETE FROM whitelisted_wallets');
      removedCount = result.rowCount ?? 0;
    }

    if (removedCount > 0) {
      console.log(`\n  ✗  Removed ${removedCount} wallet(s) no longer in list`);
    }

    console.log('\nSync complete.\n');
  } finally {
    await client.end();
  }
}

syncWhitelist().catch((err) => {
  console.error(err);
  process.exit(1);
});
