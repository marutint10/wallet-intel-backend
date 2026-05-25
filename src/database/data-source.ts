import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { join } from 'path';
import {
  getDatabaseSslOption,
  parseDatabaseSslEnv,
} from './database-options';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not configured');
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  ssl: getDatabaseSslOption(databaseUrl, parseDatabaseSslEnv()),
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
});
