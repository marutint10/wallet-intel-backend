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
PORT=3000
```

3. Start PostgreSQL and ensure `DATABASE_URL` is valid.

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