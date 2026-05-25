# Wallet Intel Backend

Minimal NestJS backend for fetching Ethereum wallet activity from Moralis.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment values into `.env`:

```env
MORALIS_API_KEY=your_key_here
DATABASE_URL=your_postgres_connection
DATABASE_CONNECTION_TIMEOUT_MS=10000
PORT=3000
```

3. Start PostgreSQL and ensure `DATABASE_URL` is valid.

If you are using Supabase, prefer the pooler connection string with `sslmode=require` on Windows or any IPv4-only network. The direct `db.<project-ref>.supabase.co:5432` endpoint is IPv6-only and will time out if your machine cannot reach IPv6.

4. Run the server:

```bash
npm run start:dev
```

## Endpoint

```http
GET /wallet/:address
```

Example:

```bash
curl http://localhost:3000/wallet/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

Example response:

```json
{
  "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "erc20_transfers": [],
  "native_transactions": []
}
```


## Database migrations (TypeORM)

Schema changes are managed with TypeORM migrations (`synchronize` is always `false`).

```bash
# Apply pending migrations
npm run migration:run

# List applied migrations
npm run migration:show

# Revert last migration
npm run migration:revert
```

### Workflow for a new schema change

1. Update the relevant `*.entity.ts` file.
2. Generate a migration:  
   `npm run migration:generate -- src/database/migrations/YourMigrationName`
3. Review the generated file under `src/database/migrations/`.
4. Apply: `npm run migration:run`
5. Commit the entity change and the migration file together.

Do not use `synchronize: true` or hand-edit schema in the Supabase SQL editor for app tables.

## Whitelist

After editing `src/auth/whitelist.ts`:

```bash
npm run migration:run   # if schema changed
npm run whitelist:sync
npm run start:dev
```